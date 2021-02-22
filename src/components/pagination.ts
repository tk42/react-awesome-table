import { ChangeEvent, useEffect, useMemo, useState } from 'react';
import { Cell, ColumnDefinition } from './types';

interface usePaginationParams<T> {
    items: T[];
    columns: ColumnDefinition<T>[];
    getRowKey: (item: T, index: number) => string;
    page?: number;
    rowsPerPage: Readonly<number>;
    rowsPerPageOptions?: Readonly<number[]>;
}

interface FilterProps {
    name: string;
    value: string;
    onChange: (event: ChangeEvent<HTMLInputElement>) => void;
}

interface usePaginationValues<T> {
    emptyRows: number;
    page: number;
    pageItems: Cell<T>[][];
    total: number;
    lastPage: number;
    hasPrev: boolean;
    hasNext: boolean;
    rowsPerPage: Readonly<number>;
    rowsPerPageOptions?: Readonly<number[]>;
    onChangePage: (event: unknown, page: number) => void;
    onChangeRowsPerPage: (event: ChangeEvent<HTMLSelectElement>) => void;
    getFilterProps: (name: keyof T) => FilterProps;
}

const defaultRowsPerPageOptions = [5, 10, 30] as const;

/**
 * TablePagination の props を生成するカスタム Hooks
 */
export const usePagination = <T>({
    items,
    columns,
    getRowKey,
    page = 0,
    rowsPerPage = defaultRowsPerPageOptions[0],
    rowsPerPageOptions = defaultRowsPerPageOptions,
}: usePaginationParams<T>): usePaginationValues<T> => {
    const [data, setData] = useState<Cell<T>[][]>([]);
    const [currentPage, setPage] = useState(page);
    const [perPage, setRowsPerPage] = useState(rowsPerPage);
    const [filter, setFilter] = useState<Record<string, string>>();

    // 初期化処理
    useEffect(() => {
        const newData: Cell<T>[][] = items.map((item, index) => {
            return columns.map((column) => ({
                entityName: column.name,
                rowKey: getRowKey(item, index),
                value: column.getValue(item),
            }));
        });
        setData(newData);
    }, [columns, getRowKey, items]);

    const filteredData = useMemo(
        () =>
            data.filter((row) => {
                if (filter) {
                    return columns.every((column) => {
                        const filterText = filter[`${column.name}`];
                        if (filterText) {
                            const cell = row.find((e) => e.entityName === column.name);
                            if (cell) {
                                return cell.value.indexOf(filterText) === 0;
                            }
                        }
                        return true;
                    });
                }
                return true;
            }),
        [columns, data, filter]
    );

    /**
     * 現在ページの表示データ
     */
    const pageItems = useMemo(
        () => filteredData.slice(currentPage * perPage, currentPage * perPage + perPage),
        [currentPage, filteredData, perPage]
    );

    /**
     * フィルタの入力処理
     * @param event
     */
    const onChangeFilter = (event: ChangeEvent<HTMLInputElement>) => {
        const { name, value } = event.target;
        setFilter((state) => {
            return state ? { ...state, [name]: value } : { [name]: value };
        });
    };

    /**
     * フィルタの input に設定する props を生成
     * @param name
     */
    const getFilterProps = (name: keyof T): FilterProps => ({
        name: `${name}`,
        value: filter ? filter[`${name}`] ?? '' : '',
        onChange: onChangeFilter,
    });

    /**
     * ページ変更
     * @param event
     * @param newPage
     */
    const onChangePage = (event: unknown, newPage: number) => {
        setPage(newPage);
    };

    /**
     * ページあたりの行数を変更
     * @param event
     */
    const onChangeRowsPerPage = (event: ChangeEvent<HTMLSelectElement>) => {
        const { value } = event.target;
        const v = parseInt(value, 10);
        if (!Number.isNaN(v)) {
            setPage(0);
            setRowsPerPage(v);
        }
    };

    /**
     * 最終ページの空行
     */
    const emptyRows = useMemo(() => {
        return perPage - Math.min(perPage, data.length - currentPage * perPage);
    }, [data.length, currentPage, perPage]);

    /**
     * 最終ページ番号
     */
    const last = useMemo(() => {
        return Math.ceil(data.length / perPage) - 1;
    }, [data.length, perPage]);

    return {
        emptyRows,
        page: currentPage,
        pageItems,
        total: filteredData.length,
        lastPage: last,
        hasPrev: currentPage !== 0,
        hasNext: currentPage !== last,
        rowsPerPage: perPage,
        rowsPerPageOptions,
        onChangePage,
        onChangeRowsPerPage,
        getFilterProps,
    };
};