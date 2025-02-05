import { getContext, setContext } from 'svelte';
import {
  type Readable,
  type Writable,
  derived,
  get,
  writable,
} from 'svelte/store';

import type { TableEntry } from '@mathesar/api/rest/types/tables';
import type { Column } from '@mathesar/api/rest/types/tables/columns';
import { States } from '@mathesar/api/rest/utils/requestUtils';
import type { DBObjectEntry } from '@mathesar/AppTypes';
import { SheetSelection } from '@mathesar/components/sheet';
import type { AbstractTypesMap } from '@mathesar/stores/abstract-types/types';
import type { ShareConsumer } from '@mathesar/utils/shares';
import { getColumnOrder } from '@mathesar/utils/tables';

import { ColumnsDataStore } from './columns';
import type { ConstraintsData } from './constraints';
import { ConstraintsDataStore } from './constraints';
import { Display } from './display';
import { Meta } from './meta';
import type {
  ProcessedColumn,
  ProcessedColumnsStore,
} from './processedColumns';
import { processColumn } from './processedColumns';
import type { RecordRow, TableRecordsData } from './records';
import { RecordsData } from './records';

export interface TabularDataProps {
  id: DBObjectEntry['id'];
  abstractTypesMap: AbstractTypesMap;
  table: TableEntry;
  meta?: Meta;
  shareConsumer?: ShareConsumer;
  /**
   * Keys are columns ids. Values are cell values.
   *
   * Setting an entry in this Map will apply a filter condition which the user
   * cannot see or remove. And the column used for the filter condition will be
   * removed from view.
   */
  contextualFilters?: Map<number, number | string>;
  hasEnhancedPrimaryKeyCell?: Parameters<
    typeof processColumn
  >[0]['hasEnhancedPrimaryKeyCell'];
}

export type TabularDataSelection = SheetSelection<RecordRow, ProcessedColumn>;

export class TabularData {
  id: DBObjectEntry['id'];

  meta: Meta;

  columnsDataStore: ColumnsDataStore;

  processedColumns: ProcessedColumnsStore;

  constraintsDataStore: ConstraintsDataStore;

  recordsData: RecordsData;

  display: Display;

  isLoading: Readable<boolean>;

  selection: TabularDataSelection;

  table: TableEntry;

  shareConsumer?: ShareConsumer;

  constructor(props: TabularDataProps) {
    const contextualFilters =
      props.contextualFilters ?? new Map<number, string | number>();
    this.id = props.id;
    this.meta = props.meta ?? new Meta();
    this.shareConsumer = props.shareConsumer;
    this.columnsDataStore = new ColumnsDataStore({
      tableId: this.id,
      hiddenColumns: contextualFilters.keys(),
      shareConsumer: this.shareConsumer,
    });
    this.constraintsDataStore = new ConstraintsDataStore({
      tableId: this.id,
      shareConsumer: this.shareConsumer,
    });
    this.recordsData = new RecordsData({
      tableId: this.id,
      meta: this.meta,
      columnsDataStore: this.columnsDataStore,
      contextualFilters,
      shareConsumer: this.shareConsumer,
    });
    this.display = new Display(
      this.meta,
      this.columnsDataStore,
      this.recordsData,
    );

    this.processedColumns = derived(
      [this.columnsDataStore.columns, this.constraintsDataStore],
      ([columns, constraintsData]) =>
        new Map(
          columns.map((column, columnIndex) => [
            column.id,
            processColumn({
              tableId: this.id,
              column,
              columnIndex,
              constraints: constraintsData.constraints,
              abstractTypeMap: props.abstractTypesMap,
              hasEnhancedPrimaryKeyCell: props.hasEnhancedPrimaryKeyCell,
            }),
          ]),
        ),
    );

    this.table = props.table;

    this.selection = new SheetSelection({
      getColumns: () => [...get(this.processedColumns).values()],
      getColumnOrder: () =>
        getColumnOrder([...get(this.processedColumns).values()], this.table),
      getRows: () => this.recordsData.getRecordRows(),
      getMaxSelectionRowIndex: () => {
        const totalCount = get(this.recordsData.totalCount) ?? 0;
        const savedRecords = get(this.recordsData.savedRecords);
        const newRecords = get(this.recordsData.newRecords);
        const pagination = get(this.meta.pagination);
        const { offset } = pagination;
        const pageSize = pagination.size;
        /**
         * We are not subtracting 1 from the below maxRowIndex calculation
         * inorder to account for the add-new-record placeholder row
         */
        return (
          Math.min(pageSize, totalCount - offset, savedRecords.length) +
          newRecords.length
        );
      },
    });

    this.isLoading = derived(
      [
        this.columnsDataStore.fetchStatus,
        this.constraintsDataStore,
        this.recordsData.state,
      ],
      ([columnsStatus, constraintsData, recordsDataState]) =>
        columnsStatus?.state === 'processing' ||
        constraintsData.state === States.Loading ||
        recordsDataState === States.Loading,
    );

    this.columnsDataStore.on('columnRenamed', async () => {
      await this.refresh();
    });
    this.columnsDataStore.on('columnAdded', async () => {
      await this.recordsData.fetch();
    });
    this.columnsDataStore.on('columnDeleted', async (columnId) => {
      this.meta.sorting.update((s) => s.without(columnId));
      this.meta.grouping.update((g) => g.withoutColumns([columnId]));
      this.meta.filtering.update((f) => f.withoutColumns([columnId]));
      await this.constraintsDataStore.fetch();
    });
    this.columnsDataStore.on('columnPatched', async () => {
      await this.recordsData.fetch();
    });
  }

  refresh(): Promise<
    [
      Column[] | undefined,
      TableRecordsData | undefined,
      ConstraintsData | undefined,
    ]
  > {
    return Promise.all([
      this.columnsDataStore.fetch(),
      this.recordsData.fetch(),
      this.constraintsDataStore.fetch(),
    ]);
  }

  refreshAfterColumnExtraction(
    extractedColumnIds: Column['id'][],
    foreignKeyColumnId?: Column['id'],
  ) {
    this.meta.sorting.update((s) => {
      const firstExtractedColumnWithSort = extractedColumnIds.find((columnId) =>
        s.has(columnId),
      );
      if (
        firstExtractedColumnWithSort &&
        foreignKeyColumnId &&
        !s.has(foreignKeyColumnId)
      ) {
        const sortDirection = s.get(firstExtractedColumnWithSort);
        return s
          .without(extractedColumnIds)
          .with(foreignKeyColumnId, sortDirection ?? 'ASCENDING');
      }
      return s.without(extractedColumnIds);
    });
    this.meta.filtering.update((f) => f.withoutColumns(extractedColumnIds));
    this.meta.grouping.update((g) => {
      const extractedColumnsHaveGrouping = extractedColumnIds.some((columnId) =>
        g.hasColumn(columnId),
      );
      if (
        extractedColumnsHaveGrouping &&
        foreignKeyColumnId &&
        !g.hasColumn(foreignKeyColumnId)
      ) {
        return g.withoutColumns(extractedColumnIds).withEntry({
          columnId: foreignKeyColumnId,
        });
      }
      return g.withoutColumns(extractedColumnIds);
    });
    return this.refresh();
  }

  destroy(): void {
    this.recordsData.destroy();
    this.constraintsDataStore.destroy();
    this.columnsDataStore.destroy();
    this.selection.destroy();
  }
}

const tabularDataStoreContextKey = {};

export function setTabularDataStoreInContext(
  t: TabularData,
): Writable<TabularData> {
  const store = writable(t);
  setContext(tabularDataStoreContextKey, store);
  return store;
}

export function getTabularDataStoreFromContext(): Writable<TabularData> {
  return getContext(tabularDataStoreContextKey);
}
