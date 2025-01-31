import hotkeys, { HotkeysEvent } from 'hotkeys-js';
import {
    ChangeEvent,
    KeyboardEvent,
    MouseEvent,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { MouseButton } from './consts';
import { MessageContext, formatMessage } from './providers/MessageProvider';
import {
    Cell,
    CellLocation,
    CellRange,
    Direction,
    EditMode,
    EditorKeyDownAction,
    EditorProps,
    FilterProps,
    HistoryCommand,
    HotkeyProps,
    RowHeaderCellProps,
    SortProps,
    SortState,
    TableData,
    TableHookParameters,
    TableHookReturns,
    TableOptions,
    defaultTableOptions,
    getCellComponentType,
} from './types';
import {
    clearSelection,
    clone,
    compareLocation,
    compareValue,
    convertRange,
    debug,
    equalsCells,
    equalsLocation,
    getDefaultValue,
    includesLocation,
    isChildOfTableCell,
    parse,
    safeGetCell,
    selectRange,
    withinCell,
    withinRange,
} from './util';
import { validateCell } from './validate';

/**
 * ページあたりの行数のデフォルト候補
 */
const defaultRowsPerPageOptions = [5, 10, 30] as const;

/**
 * Table の props を生成するカスタム Hooks
 */
export const useTable = <T>({
    items,
    columns,
    getRowKey,
    onChange,
    page = 0,
    rowsPerPage = defaultRowsPerPageOptions[0],
    rowsPerPageOptions = defaultRowsPerPageOptions,
    options = defaultTableOptions,
    readOnly = false,
    disableUndo = false,
}: TableHookParameters<T>): TableHookReturns<T> => {
    // props に以前渡されたデータ
    const [prevItems, setPrevItems] = useState<string>();
    // データ全体
    const [data, setData] = useState<TableData<T>>([]);
    // 現在表示ページ
    const [currentPage, setPage] = useState(page);
    // ページあたりの行数
    const [perPage, setRowsPerPage] = useState(rowsPerPage);
    // フィルタリング文字列
    const [filter, setFilter] = useState<Record<string, string>>();
    // ソート情報
    const [sort, setSort] = useState<SortState[]>([]);
    // 現在フォーカスのあるセル
    const [currentCell, setCurrentCell] = useState<CellLocation>();
    // 現在編集中のセル
    const [editCell, setEditCell] = useState<{ location: CellLocation; value: string }>();
    // 現在選択中のセル
    const [selection, setSelection] = useState<CellLocation[]>([]);
    // テーブルがフォーカスを持っている
    const [focus, setFocus] = useState(false);
    // ドラッグ中かどうか
    const [dragging, setDragging] = useState(false);
    // 行のドラッグ
    const [draggingRow, setDraggingRow] = useState(false);
    // undoデータ
    const [undo, setUndo] = useState<TableData<T>[]>([]);
    // undo履歴の位置
    const [undoIndex, setUndoIndex] = useState(-1);
    // 編集モード
    const [mode, setMode] = useState<EditMode>('normal');
    // 翻訳データ
    const messages = useContext(MessageContext);

    // tbody
    const tbodyRef = useRef<HTMLTableSectionElement>();
    // timer
    const timer = useRef<NodeJS.Timeout>();

    /**
     * undo履歴に追加する
     */
    const pushUndoList = useCallback(
        (cells: TableData<T>) => {
            // undo/redo無効時は履歴更新しない
            if (disableUndo) {
                return;
            }
            // 最新の履歴と登録データを比較して、履歴追加が必要か判定
            if (undo.length > 0) {
                if (equalsCells(cells, undo[undoIndex])) {
                    return;
                }
            }

            const temp = clone(cells);
            const index = undoIndex + 1;
            // カレントのundo履歴以降の履歴データを削除
            const history = clone(undo).slice(0, index);
            // 履歴追加
            history.push(temp);
            debug('undo list: ', history);

            // state更新
            setUndo(history);
            setUndoIndex(index);
        },
        [disableUndo, undo, undoIndex]
    );

    /**
     * オプション設定
     */
    const settings: TableOptions = useMemo(() => {
        return {
            ...defaultTableOptions,
            ...options,
        };
    }, [options]);

    /**
     * テーブルの列数, 非表示列を除く列の先頭, 非表示列を除く列の末尾
     */
    const [columnLength, columnHead, columnTail]: [number, number, number] = useMemo(() => {
        let head = columns.length;
        let tail = 0;

        columns.forEach(({ hidden = false }, index) => {
            if (!hidden) {
                if (head > index) {
                    head = index;
                }
                if (tail < index) {
                    tail = index;
                }
            }
        });

        return [columns.length, head, tail];
    }, [columns]);

    /**
     * ページ表示範囲
     */
    const currentPageRange: CellRange = useMemo(() => {
        const startRow = currentPage * perPage;
        const endRow = startRow + perPage - 1;
        return {
            start: {
                row: startRow,
                column: 0,
            },
            end: {
                row: endRow,
                column: columnLength - 1,
            },
        };
    }, [columnLength, currentPage, perPage]);

    /**
     * 選択範囲
     */
    const selectedRange: CellRange | undefined = useMemo(() => {
        return convertRange(selection);
    }, [selection]);

    /**
     * 当該イベントが td で発生したかどうかを判定
     * @param event
     */
    const isOccurredByCell = useCallback((event: globalThis.MouseEvent): boolean => {
        const source = event.target as HTMLElement;
        return isChildOfTableCell(source);
    }, []);

    /**
     * document での mouse down イベント
     * @param event
     */
    const handleMouseDownDocument = useCallback(
        (event: globalThis.MouseEvent) => {
            const within = isOccurredByCell(event);
            debug('document mouse down', within);

            setFocus(within);
        },
        [isOccurredByCell]
    );

    /**
     * document での mouse upイベント
     * @param event
     */
    const handleMouseUpDocument = useCallback(
        (event: globalThis.MouseEvent) => {
            if (tbodyRef.current) {
                if (!isOccurredByCell(event)) {
                    debug('drag end.');
                    // ドラッグ強制終了
                    setDragging(false);
                    setDraggingRow(false);
                }
            }
        },
        [isOccurredByCell]
    );

    /**
     * クリップボードにコピーするデータを生成する
     */
    const getSelectedCellValues = useCallback((): string => {
        if (selection) {
            // 選択範囲をソート
            const range = selection.sort(compareLocation);
            // 選択範囲の値を配列にセット
            const copiedData: string[][] = [];
            let currentRowIndex = range[0].row;
            const rowValues: string[] = [];
            range.forEach((location) => {
                if (location.row !== currentRowIndex) {
                    copiedData.push([...rowValues]);
                    // 配列をクリア
                    rowValues.splice(0, rowValues.length);
                    currentRowIndex = location.row;
                }

                rowValues.push(data[location.row][location.column].value);
            });
            if (rowValues.length > 0) {
                copiedData.push([...rowValues]);
            }
            // 配列をくっつけて文字列にする
            return copiedData.map((row) => row.join('\t')).join('\n');
        }
        return '';
    }, [data, selection]);

    /**
     * copy
     * @param event
     */
    const handleCopy = useCallback(
        (event: globalThis.ClipboardEvent) => {
            if (focus && !Boolean(editCell)) {
                const copyData = getSelectedCellValues();
                debug('copy: ', copyData);
                event.clipboardData.setData('text/plain', copyData);
                event.preventDefault();
            }
        },
        [getSelectedCellValues, editCell, focus]
    );

    /**
     * セルに値をセットする (注意! 引数の cells を変更します)
     * @returns value が更新されたかどうか
     */
    const setCellValue = useCallback(
        (value: string, location: CellLocation, cells: TableData<T>): boolean => {
            debug('setCellValue: ', `"${value}"`, location);
            let changed = false;
            const cell = cells[location.row][location.column];
            const column = columns.find((c) => c.name === cell.entityName);
            if (column) {
                // 読み取り専用時は更新しない
                if (readOnly || cell.readOnly) {
                    return false;
                }

                // 値のセット
                if (cell.value !== value) {
                    cell.value = value;
                    changed = true;
                }

                // エラーチェック
                const [valid, message] = validateCell(column, value, location, cells, messages);
                cell.invalid = !valid;
                cell.invalidMessage = message;
            }

            return changed;
        },
        [columns, messages, readOnly]
    );

    /**
     * onChangeの呼び出し
     */
    const executeChange = useCallback(
        (cells: TableData<T>) => {
            if (onChange) {
                // invalid な cell が存在する？
                const invalid = cells.some((row) => row.some((cell) => cell.invalid));
                // 返却データの作成
                const newData = parse(items, cells, columns, getRowKey);
                onChange(newData, invalid);
            }
        },
        [columns, getRowKey, items, onChange]
    );

    /**
     * 更新処理
     */
    const handleChange = useCallback(
        (cells: TableData<T>) => {
            if (timer.current) {
                clearTimeout(timer.current);
            }
            timer.current = setTimeout(() => executeChange(cells), 100);
        },
        [executeChange]
    );

    /**
     * セルの編集を開始する (stateを更新します)
     */
    const startEditing = useCallback(
        (location: CellLocation, defaultValue?: string, inputMode: EditMode = 'input') => {
            if (readOnly || data[location.row][location.column].readOnly) {
                // 読み取り専用の場合は何もしない
                return;
            }
            debug('startEditing');
            const newData = clone(data);
            const cell = newData[location.row][location.column];
            cell.editing = true;

            // 初期値のセット
            let value = cell.value;
            if (cell.cellType === 'text' && typeof defaultValue !== 'undefined') {
                value = defaultValue;
            }

            setEditCell({
                location,
                value,
            });
            setData(newData);
            setMode(inputMode);
        },
        [data, readOnly]
    );

    /**
     * セルの編集を終了する (注意! 引数の cells を変更します)
     * 編集が確定されていない場合、編集中の内容は破棄されます。
     */
    const endEditing = useCallback(
        (cells: TableData<T>): TableData<T> => {
            if (editCell) {
                debug('endEditing: ', editCell.location);
                cells[editCell.location.row][editCell.location.column].editing = false;
                setEditCell(undefined);
                // 通常モードにする
                setMode('normal');
            }
            return cells;
        },
        [editCell]
    );

    /**
     * セルの編集を終了する
     */
    const cancelEditing = useCallback(() => {
        let newData = clone(data);
        newData = endEditing(newData);
        setData(newData);
    }, [data, endEditing]);

    /**
     * セルの編集を確定する (注意! 引数の cells を変更します)
     */
    const commitEditing = useCallback(
        (cells: TableData<T>, optionValue?: string): TableData<T> => {
            debug('commitEditing');
            // セルの更新する
            const { location, value } = editCell;
            let val: string = value;
            if (typeof optionValue !== 'undefined') {
                val = optionValue;
            }
            const changed = setCellValue(val, location, cells);
            // 編集終了
            const d = endEditing(cells);

            if (changed) {
                handleChange(cells);
                // 履歴更新
                pushUndoList(cells);
            }

            return d;
        },
        [editCell, endEditing, handleChange, pushUndoList, setCellValue]
    );

    /**
     * セルの編集を確定する
     */
    const commit = useCallback(
        (value: string) => {
            const cells = clone(data);
            commitEditing(cells, value);
            setData(cells);
        },
        [commitEditing, data]
    );

    /**
     * 空行を生成する
     * (行の挿入は行わない)
     */
    const makeNewRow = useCallback(
        (row: number, cells: TableData<T>): Cell<T>[] => {
            return columns.map((column, index) => {
                // 初期値
                const value = getDefaultValue(row, cells, column.defaultValue);

                // エラーチェック
                const [valid, message] = validateCell(
                    column,
                    value,
                    { row, column: index },
                    cells,
                    messages
                );

                return {
                    entityName: column.name,
                    rowKey: getRowKey(undefined, row, cells),
                    value,
                    invalid: !valid,
                    invalidMessage: message,
                    readOnly: column.readOnly,
                    cellType: getCellComponentType(column),
                    hidden: column.hidden ?? false,
                };
            });
        },
        [columns, getRowKey, messages]
    );

    // 初期化処理
    useEffect(() => {
        const rawItems = JSON.stringify(items);

        // items が更新されているか、未登録なら初期化処理を行う
        if (typeof prevItems === 'undefined' || prevItems !== rawItems) {
            const newData: TableData<T> = items.map((item, rowIndex) => {
                return columns.map((column) => {
                    const value = column.hasOwnProperty('getValue')
                        ? column.getValue(item)
                        : item[column.name].toString();

                    const cell: Cell<T> = {
                        entityName: column.name,
                        rowKey: getRowKey(item, rowIndex),
                        value,
                        readOnly: (readOnly || column.readOnly) ?? false,
                        cellType: getCellComponentType(column),
                        hidden: column.hidden ?? false,
                    };
                    return cell;
                });
            });
            if (newData.length === 0) {
                const emptyRow = makeNewRow(0, newData);
                newData.push(emptyRow);
            }

            // 入力チェック
            newData.forEach((row, rowIndex) => {
                columns.forEach((column, colIndex) => {
                    const cell = row[colIndex];
                    if (cell.hidden) {
                        // 非表示セルは除外
                        return;
                    }

                    const location: CellLocation = { row: rowIndex, column: colIndex };
                    const [valid, message] = validateCell(
                        column,
                        cell.value,
                        location,
                        newData,
                        messages
                    );
                    if (!valid) {
                        cell.invalid = true;
                        cell.invalidMessage = message;
                    }
                });
            });

            setData(newData);
            setPrevItems(rawItems);

            // UNDO履歴の更新
            pushUndoList(newData);
        }
    }, [
        columns,
        data.length,
        getRowKey,
        items,
        makeNewRow,
        messages,
        prevItems,
        pushUndoList,
        readOnly,
    ]);

    /**
     * クリップボードの複数セルデータをカレントセルを起点にペーストする
     */
    const pasteFromItems = useCallback(
        (
            pasteItems: string[][],
            cells: TableData<T>,
            current: CellLocation
        ): [boolean, CellLocation[]] => {
            let changed = false;
            const newSelection: CellLocation[] = [];

            for (let i = 0; i < pasteItems.length; i++) {
                const row = current.row + i;
                if (row >= cells.length) {
                    // 新規行を追加
                    const newRow = makeNewRow(row, cells);
                    cells.push(newRow);
                    changed = true;
                }

                for (let j = 0; j < pasteItems[i].length; j++) {
                    let column = current.column + j;
                    // 非表示セルをスキップ
                    while (cells[row][column]?.hidden) {
                        column += 1;
                    }

                    if (column >= cells[row].length) {
                        // 範囲外のため貼り付けしない
                        break;
                    }

                    // 貼り付け処理
                    const value = pasteItems[i][j];
                    const location: CellLocation = { row, column };
                    if (setCellValue(value, location, cells)) {
                        changed = true;
                    }

                    // 貼り付け範囲を選択
                    cells[row][column].selected = true;
                    newSelection.push(location);
                }
            }

            return [changed, newSelection];
        },
        [makeNewRow, setCellValue]
    );

    /**
     * クリップボードの値を選択範囲のすべてのセルにペーストする
     */
    const pasteToSelection = useCallback(
        (pasteItem: string, cells: TableData<T>, selectedCells: CellLocation[]): boolean => {
            let changed = false;

            selectedCells.forEach((location) => {
                if (setCellValue(pasteItem, location, cells)) {
                    changed = true;
                }
                cells[location.row][location.column].selected = true;
            });

            return changed;
        },
        [setCellValue]
    );

    /**
     * 選択範囲の各行にクリップボードのデータをペースト
     */
    const pasteToSelectedRows = useCallback(
        (
            pasteDataRow: string[],
            cells: TableData<T>,
            selectedCells: CellLocation[]
        ): [boolean, CellLocation[]] => {
            let changed = false;
            const newSelection: CellLocation[] = [];
            const selectedRows = new Set<number>();
            let startColumn = Number.MAX_SAFE_INTEGER;

            // 選択行/開始列を取得
            selectedCells.forEach(({ row, column }) => {
                if (startColumn > column) {
                    startColumn = column;
                }
                selectedRows.add(row);
            });

            [...selectedRows].sort().forEach((row) => {
                // 行に値をペースト
                for (let c = 0; c < pasteDataRow.length; c++) {
                    let column = startColumn + c;
                    // 非表示列をスキップ
                    while (cells[row][column]?.hidden) {
                        column += 1;
                    }
                    if (column >= cells[row].length) {
                        // 列が範囲外
                        break;
                    }
                    // 対象セル
                    const location: CellLocation = { row, column };
                    newSelection.push(location);

                    if (setCellValue(pasteDataRow[c], location, cells)) {
                        changed = true;
                    }
                    cells[row][column].selected = true;
                }
            });

            return [changed, newSelection];
        },
        [setCellValue]
    );

    /**
     * 値のペースト
     */
    const pasteData = useCallback(
        (rawData: string) => {
            if (currentCell && rawData) {
                // 改行・タブで区切って配列に変換
                const pasteItems: string[][] = rawData
                    .split('\n')
                    .map((value) => value.replace('\r', '').split('\t'));
                debug(pasteItems);

                const newData = data.map((row) =>
                    row.map((cell) => ({
                        ...cell,
                        selected: false,
                    }))
                );
                let changed = false;

                if (pasteItems.length === 1 && pasteItems[0].length === 1) {
                    // 単一セルのコピー
                    const pasteItem = pasteItems[0][0];
                    changed = pasteToSelection(pasteItem, newData, selection);
                } else if (pasteItems.length === 1 && pasteItems[0].length > 1) {
                    // 行データのコピー
                    const pasteRow = pasteItems[0];
                    const [isChanged, newSelection] = pasteToSelectedRows(
                        pasteRow,
                        newData,
                        selection
                    );
                    changed = isChanged;
                    // 選択範囲を更新
                    if (changed && newSelection.length > 0) {
                        setSelection(newSelection);
                    }
                } else {
                    // 複数セルのコピー
                    const [isChanged, newSelection] = pasteFromItems(
                        pasteItems,
                        newData,
                        currentCell
                    );
                    changed = isChanged;
                    // 選択範囲を更新
                    if (changed && newSelection.length > 0) {
                        setSelection(newSelection);
                    }
                }

                // stateの更新
                setData(newData);

                if (changed) {
                    handleChange(newData);
                    // 履歴更新
                    pushUndoList(newData);
                }
            }
        },
        [
            currentCell,
            data,
            handleChange,
            pasteFromItems,
            pasteToSelectedRows,
            pasteToSelection,
            pushUndoList,
            selection,
        ]
    );

    /**
     * paste
     */
    const handlePaste = useCallback(
        (event: globalThis.ClipboardEvent) => {
            if (!readOnly && focus && !Boolean(editCell) && currentCell) {
                const rawData = event.clipboardData.getData('text');
                debug('paste: ', rawData);

                pasteData(rawData);
            }
        },
        [currentCell, editCell, focus, pasteData, readOnly]
    );

    /**
     * ブラウザ ウィンドウ からフォーカスが外れた場合
     */
    const handleBlurDocument = useCallback(() => {
        setFocus(false);
    }, []);

    // イベントリスナーの設定
    useEffect(() => {
        document.addEventListener('mousedown', handleMouseDownDocument);
        document.addEventListener('mouseup', handleMouseUpDocument);
        document.addEventListener('copy', handleCopy);
        document.addEventListener('paste', handlePaste);
        window.addEventListener('blur', handleBlurDocument);

        return () => {
            // イベントリスナーの削除
            document.removeEventListener('mousedown', handleMouseDownDocument);
            document.removeEventListener('mouseup', handleMouseUpDocument);
            document.removeEventListener('copy', handleCopy);
            document.removeEventListener('paste', handlePaste);
            window.removeEventListener('blur', handleBlurDocument);
        };
    }, [
        handleBlurDocument,
        handleCopy,
        handleMouseDownDocument,
        handleMouseUpDocument,
        handlePaste,
    ]);

    // --- hotkeys ---

    /**
     * 行数からページ番号を割り出す
     */
    const getPageNumberFromRowIndex = useCallback(
        (rowIndex: number): number => {
            debug(`getPageNumberFromRowIndex: rowIndex=${rowIndex}, rowsPerPage=${perPage}`);
            return Math.ceil((rowIndex + 1) / perPage) - 1;
        },
        [perPage]
    );

    /**
     * カーソル移動
     * @param row
     * @param column
     */
    const navigateCursor = useCallback(
        (
            moveRows: number,
            moveColumns: number,
            cells: TableData<T>,
            pressedEnter = false
        ): TableData<T> => {
            debug('navigateCursor', moveRows, moveColumns, currentCell);
            if (currentCell) {
                // カーソル位置
                const newCurrent: CellLocation = {
                    ...currentCell,
                };

                do {
                    // 新しいカーソル位置
                    newCurrent.row += moveRows;
                    newCurrent.column += moveColumns;

                    // 移動可能か判定
                    if (newCurrent.column < 0) {
                        if (settings.navigateCellFromRowEdge === 'prevOrNextRow') {
                            // 前行の最後尾に移動
                            newCurrent.row -= 1;
                            newCurrent.column = columnLength - 1;
                        } else if (settings.navigateCellFromRowEdge === 'loop') {
                            // 同一行の最後尾に移動
                            newCurrent.column = columnLength - 1;
                        } else {
                            // 移動不可
                            return cells;
                        }
                    }

                    if (newCurrent.column >= columnLength) {
                        if (settings.navigateCellFromRowEdge === 'prevOrNextRow') {
                            // 次行の先頭に移動
                            newCurrent.row += 1;
                            newCurrent.column = 0;
                        } else if (settings.navigateCellFromRowEdge === 'loop') {
                            // 同一行の先頭に移動
                            newCurrent.column = 0;
                        } else {
                            // 移動不可
                            return cells;
                        }
                    }
                    // 非表示セルであればもう一度カーソル位置を移動
                } while (safeGetCell(cells, newCurrent.row, newCurrent.column)?.hidden);

                if (newCurrent.row >= data.length) {
                    if (settings.pressEnterOnLastRow === 'insert' && pressedEnter) {
                        // 行追加する
                        const row = makeNewRow(newCurrent.row, cells);
                        cells.push(row);
                    } else {
                        // 移動不可
                        return cells;
                    }
                }

                if (newCurrent.row < 0) {
                    // 移動不可
                    return cells;
                }

                // 行数からページ番号を割り出して
                // 前/次ページに移動した場合はページ番号を更新
                const newPage = getPageNumberFromRowIndex(newCurrent.row);
                if (currentPage !== newPage) {
                    setPage(newPage);
                }

                // state更新
                setSelection([newCurrent]);
                setCurrentCell(newCurrent);

                return cells;
            }
        },
        [
            columnLength,
            currentCell,
            currentPage,
            data?.length,
            getPageNumberFromRowIndex,
            makeNewRow,
            settings.navigateCellFromRowEdge,
            settings.pressEnterOnLastRow,
        ]
    );

    /**
     * キー押下によるセル移動の前処理
     */
    const beforeKeyDown = useCallback(
        (cells: TableData<T>) => {
            if (editCell) {
                // DropdownのPopover表示中はカーソル移動しない
                const cell = cells[editCell.location.row][editCell.location.column];
                if (cell.cellType === 'select' && cell.editing) {
                    return;
                }
                // 更新を確定する
                return commitEditing(cells);
            }
            return cells;
        },
        [commitEditing, editCell]
    );

    /**
     * 矢印キーによるカーソル移動
     */
    const keyDownArrow = useCallback(
        (key: string) => {
            let cells = clone(data ?? []);
            cells = beforeKeyDown(cells);

            switch (key) {
                case 'left':
                    cells = navigateCursor(0, -1, cells);
                    break;
                case 'right':
                    cells = navigateCursor(0, 1, cells);
                    break;
                case 'up':
                    cells = navigateCursor(-1, 0, cells);
                    break;
                case 'down':
                    cells = navigateCursor(1, 0, cells);
                    break;
            }

            setData(cells);
        },
        [beforeKeyDown, data, navigateCursor]
    );

    /**
     * 矢印キーによるカーソル移動
     */
    const handleArrowKeyDown = useCallback(
        (event: globalThis.KeyboardEvent, hotkeysEvent: HotkeysEvent) => {
            if (!focus || editCell) {
                // フォーカスが無い、あるいは編集中の場合は何もしない
                return;
            }
            const { key } = hotkeysEvent;
            debug('handleArrowKeyDown: ', key);
            keyDownArrow(key);
            // デフォルトの挙動をキャンセル
            event.preventDefault();
        },
        [editCell, focus, keyDownArrow]
    );

    /**
     * 選択範囲を拡張する
     */
    const expandSelection = useCallback(
        (direction: Direction, cells: TableData<T>): [boolean, TableData<T>, CellLocation[]] => {
            // 現在の選択範囲
            const range = convertRange(selection);
            if (!range) {
                return [false, cells, selection];
            }

            switch (direction) {
                case 'up':
                    range.start.row -= 1;
                    if (
                        range.start.row < 0 ||
                        getPageNumberFromRowIndex(range.start.row) !== currentPage
                    ) {
                        return [false, cells, selection];
                    }
                    break;
                case 'down':
                    range.end.row += 1;
                    if (
                        range.end.row >= cells.length ||
                        getPageNumberFromRowIndex(range.end.row) !== currentPage
                    ) {
                        return [false, cells, selection];
                    }
                    break;
                case 'left':
                    // 左方向に選択範囲を拡張
                    do {
                        range.start.column -= 1;
                    } while (cells[range.start.row][range.start.column]?.hidden);

                    if (range.start.column < 0) {
                        return [false, cells, selection];
                    }
                    break;
                case 'right':
                    // 右方向に選択範囲を拡張
                    do {
                        range.end.column += 1;
                    } while (cells[range.start.row][range.start.column]?.hidden);

                    if (range.end.column >= columnLength) {
                        return [false, cells, selection];
                    }
                    break;
            }

            // 選択範囲の更新
            const newSelection = selectRange(cells, range);

            return [true, cells, newSelection];
        },
        [columnLength, currentPage, getPageNumberFromRowIndex, selection]
    );

    /**
     * Shift+矢印キーによる選択範囲の拡張
     */
    const keyDownShiftArrow = useCallback(
        (key: string) => {
            let cells = clone(data);
            cells = beforeKeyDown(cells);
            let direction: Direction;
            switch (key) {
                case 'shift+left':
                    direction = 'left';
                    break;
                case 'shift+right':
                    direction = 'right';
                    break;
                case 'shift+up':
                    direction = 'up';
                    break;
                case 'shift+down':
                    direction = 'down';
                    break;
            }

            const [ok, newData, newSelection] = expandSelection(direction, cells);
            if (ok) {
                setData(newData);
                setSelection(newSelection);
            }
        },
        [beforeKeyDown, data, expandSelection]
    );

    /**
     * Shift+矢印キーによる選択範囲の拡張
     */
    const handleShiftArrowKeyDown = useCallback(
        (event: globalThis.KeyboardEvent, hotkeysEvent: HotkeysEvent) => {
            if (!focus || editCell) {
                // フォーカスが無い、あるいは編集中の場合は何もしない
                return;
            }
            const { key } = hotkeysEvent;
            debug('handleShiftArrowKeyDown: ', key);
            keyDownShiftArrow(key);
            // デフォルトの挙動をキャンセル
            event.preventDefault();
        },
        [editCell, focus, keyDownShiftArrow]
    );

    /**
     * Tab, Enterによるカーソル移動
     */
    const keyDownTabEnter = useCallback(
        (key: string) => {
            let cells = clone(data);
            cells = beforeKeyDown(cells);

            switch (key) {
                case 'shift+tab':
                    cells = navigateCursor(0, -1, cells);
                    break;
                case 'tab':
                    cells = navigateCursor(0, 1, cells);
                    break;
                case 'shift+enter':
                    cells = navigateCursor(-1, 0, cells);
                    break;
                case 'enter':
                    cells = navigateCursor(1, 0, cells, true);
                    break;
            }

            setData(cells);
        },
        [beforeKeyDown, data, navigateCursor]
    );

    /**
     * Tab, Enterによるカーソル移動 (hotkeysから呼ばれる)
     */
    const handleTabKeyDown = useCallback(
        (event: globalThis.KeyboardEvent, hotkeysEvent: HotkeysEvent) => {
            if (!focus) {
                return;
            }

            const { key } = hotkeysEvent;
            debug('handleTabKeyDown: ', key);

            // カーソル移動
            keyDownTabEnter(key);
            // デフォルトの挙動をキャンセル
            event.preventDefault();
        },
        [focus, keyDownTabEnter]
    );

    /**
     * F2キーによる編集開始
     */
    const handleF2KeyDown = useCallback(
        (event: globalThis.KeyboardEvent) => {
            if (!focus) {
                return;
            }
            if (editCell) {
                return;
            }

            // 編集開始
            if (currentCell) {
                startEditing(currentCell, undefined, 'edit');
                // デフォルトの挙動をキャンセル
                event.preventDefault();
            }
        },
        [currentCell, editCell, focus, startEditing]
    );

    /**
     * undo/redo 処理
     */
    const restoreHistory = useCallback(
        (command: HistoryCommand) => {
            debug(`${command}: `, undoIndex, undo);
            let index = undoIndex;
            if (command === 'undo') {
                index = Math.max(-1, index - 1);
            } else {
                index = index === undo.length - 1 ? index : index + 1;
            }

            if (index !== undoIndex && index > -1) {
                const history = clone(undo[index]);

                setData(history);
                setUndoIndex(index);

                // onChangeを呼び出す
                handleChange(history);
            }
        },
        [handleChange, undo, undoIndex]
    );

    /**
     * Ctrl+Z / Ctrl+Y による undo/redo
     */
    const handleUndoRedo = useCallback(
        (event: globalThis.KeyboardEvent, hotkeysEvent: HotkeysEvent) => {
            if (!focus) {
                return;
            }
            if (readOnly) {
                return;
            }
            if (disableUndo) {
                return;
            }
            if (editCell) {
                return;
            }

            const { key } = hotkeysEvent;
            debug('handleUndoRedo: ', key);

            switch (key) {
                case 'ctrl+z':
                    restoreHistory('undo');
                    break;
                case 'command+z':
                    restoreHistory('undo');
                    break;
                case 'ctrl+y':
                    restoreHistory('redo');
                    break;
                case 'command+y':
                    restoreHistory('redo');
                    break;
            }

            // デフォルトの挙動をキャンセル
            event.preventDefault();
        },
        [disableUndo, editCell, focus, readOnly, restoreHistory]
    );

    /**
     * 範囲選択
     */
    const onSelect = useCallback(
        (range: CellRange) => {
            // 引数の range が現在ページの範囲内？
            if (!withinRange(currentPageRange, range)) {
                // 範囲外であれば終了
                return;
            }

            const cells = clone(data);
            // 編集中なら確定
            if (editCell) {
                commitEditing(cells);
            }
            // 範囲選択
            const newSelection = selectRange(cells, range);

            // カレントセルの更新要否
            let needUpdateCurrent = true;
            if (currentCell) {
                if (withinCell(range, currentCell)) {
                    // カレントセルが選択範囲内なら更新不要
                    needUpdateCurrent = false;
                }
            }

            if (needUpdateCurrent) {
                // 選択範囲の先頭をカレントセルとする
                const newCurrent = clone(range.start);
                setCurrentCell(newCurrent);
            }

            // state保存
            setSelection(newSelection);
            setData(cells);
        },
        [commitEditing, currentCell, currentPageRange, data, editCell]
    );

    /**
     * 全件選択
     */
    const onSelectAll = useCallback(() => {
        // 現在表示しているページを範囲選択
        onSelect(currentPageRange);
    }, [currentPageRange, onSelect]);

    /**
     * Ctrl+A で全件選択
     */
    const handleCtrlAKeyDown = useCallback(
        (event: globalThis.KeyboardEvent) => {
            // フォーカスがないor編集中であれば何もしない
            if (!focus) {
                return;
            }
            if (editCell) {
                return;
            }

            // 全件選択
            onSelectAll();
            // デフォルトの挙動をキャンセル
            event.preventDefault();
        },
        [editCell, focus, onSelectAll]
    );

    /**
     * 選択範囲の値を削除する
     */
    const clearSelectedCells = useCallback(() => {
        const cells = clone(data);
        let changed = false;

        selection.forEach((location) => {
            // 値に空文字列をセット
            const cellChanged = setCellValue('', location, cells);
            changed = changed || cellChanged;
        });

        if (changed) {
            setData(cells);
            handleChange(cells);
            pushUndoList(cells);
        }
    }, [data, handleChange, pushUndoList, selection, setCellValue]);

    /**
     * 選択範囲の値を編集中のセルの値で一括置換する
     */
    const editMultipleCells = useCallback(() => {
        const cells = clone(data);
        let changed = false;

        selection.forEach((location) => {
            // 値に編集中セルの値をセット
            const cellChanged = setCellValue(editCell.value, location, cells);
            changed = changed || cellChanged;
        });

        if (changed) {
            setData(cells);
            handleChange(cells);
            pushUndoList(cells);
        }
    }, [data, handleChange, pushUndoList, selection, setCellValue, editCell]);

    /**
     * 任意のキー押下で値をセットするとともに編集開始
     */
    const handleAnyKeyDown = useCallback(
        (event: globalThis.KeyboardEvent, hotkeysEvent: HotkeysEvent) => {
            if (!focus) {
                return;
            }
            if (editCell) {
                return;
            }

            if (currentCell) {
                const { key, metaKey, ctrlKey } = event;
                debug('handleAnyKeyDown: ', key);

                let defaultPrevent = false;

                if ('enter' === key.toLowerCase()) {
                    // 入力モードで編集開始
                    startEditing(currentCell, data[currentCell.row][currentCell.column].value);
                } else if (['delete', 'backspace', 'clear'].includes(key.toLowerCase())) {
                    if (selection.length > 1) {
                        clearSelectedCells();
                    } else {
                        // 入力モードで削除 & 編集開始
                        startEditing(currentCell, '');
                    }
                    defaultPrevent = true;
                }
                if (key.length === 1 && !metaKey && !ctrlKey) {
                    // 入力モードで編集開始
                    startEditing(currentCell, key);
                    defaultPrevent = true;
                }

                if (defaultPrevent) {
                    event.preventDefault();
                }
            }
        },
        [clearSelectedCells, currentCell, editCell, focus, data, selection.length, startEditing]
    );

    /**
     * Hotkeysの設定
     */
    const hotkeySettings: HotkeyProps[] = useMemo(() => {
        return [
            // 矢印キー
            {
                keys: 'left,right,up,down',
                handler: handleArrowKeyDown,
            },
            // Shift+矢印キー
            {
                keys: 'shift+left,shift+right,shift+up,shift+down',
                handler: handleShiftArrowKeyDown,
            },
            // Tab, Enter
            {
                keys: 'shift+tab,tab,shift+enter,enter',
                handler: handleTabKeyDown,
            },
            // F2
            {
                keys: 'f2',
                handler: handleF2KeyDown,
            },
            // Ctrl+Z/Ctrl+Y
            {
                keys: 'ctrl+z,command+z,ctrl+y,command+y',
                handler: handleUndoRedo,
            },
            // Ctrl+A
            {
                keys: 'ctrl+a,command+a',
                handler: handleCtrlAKeyDown,
            },
            // any
            {
                keys: '*',
                handler: handleAnyKeyDown,
            },
        ];
    }, [
        handleAnyKeyDown,
        handleArrowKeyDown,
        handleCtrlAKeyDown,
        handleF2KeyDown,
        handleShiftArrowKeyDown,
        handleTabKeyDown,
        handleUndoRedo,
    ]);

    // Hotkeys
    useEffect(() => {
        hotkeySettings.forEach(({ keys, handler }) => {
            hotkeys(keys, handler);
        });

        return () => {
            // 割当削除
            hotkeySettings.forEach(({ keys }) => {
                hotkeys.unbind(keys);
            });
        };
    }, [hotkeySettings]);

    /**
     * フィルタリングされたデータ
     */
    const filteredData = useMemo(
        () =>
            data?.filter((row) => {
                if (filter) {
                    return columns.every((column) => {
                        const filterText = filter[`${String(column.name)}`];
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
            }) ?? [],
        [columns, data, filter]
    );

    /**
     * カレントセルと選択セルの反映
     */
    const displayItems = useMemo(() => {
        return filteredData
            .slice(currentPage * perPage, currentPage * perPage + perPage)
            .map((row, rowIndex) => {
                return row.map((cell, columnIndex) => {
                    const location: CellLocation = {
                        row: rowIndex + currentPage * perPage,
                        column: columnIndex,
                    };
                    return {
                        ...cell,
                        current: equalsLocation(location, currentCell),
                        selected: includesLocation(location, selection),
                    };
                });
            });
    }, [currentCell, currentPage, filteredData, perPage, selection]);

    /**
     * 最終ページの空行数
     */
    const emptyRows = useMemo(() => {
        return perPage - Math.min(perPage, (data?.length ?? 0) - currentPage * perPage);
    }, [data?.length, currentPage, perPage]);

    /**
     * 最終ページ番号
     */
    const last = useMemo(() => {
        if (typeof data === 'undefined' || data.length === 0) {
            return 0;
        }
        return Math.ceil(data.length / perPage) - 1;
    }, [data, perPage]);

    /**
     * 選択状態、カレントセルをクリア
     */
    const clearSelectionAndCurrentCell = useCallback(() => {
        const newData = clone(data);
        // 選択状態の解除
        clearSelection(newData, selection);
        if (currentCell) {
            // カレントセルのクリア
            newData[currentCell.row][currentCell.column].current = false;
        }
        setData(newData);
        setCurrentCell(undefined);
        setSelection([]);
    }, [currentCell, data, selection]);

    /**
     * フィルタの入力処理
     * @param event
     */
    const onChangeFilter = useCallback(
        (event: ChangeEvent<HTMLInputElement>) => {
            if (!settings.filterable) {
                return;
            }

            const { name, value } = event.target;
            setFilter((state) => {
                return state ? { ...state, [name]: value } : { [name]: value };
            });
            // ページングをリセットする
            setPage(0);
            // カレントセル、選択状態をクリアする
            clearSelectionAndCurrentCell();
        },
        [clearSelectionAndCurrentCell, settings.filterable]
    );

    /**
     * フィルタの input に設定する props を生成
     * @param name
     */
    const getFilterProps = useCallback(
        (name: keyof T): FilterProps => {
            const column = columns.find((c) => c.name === name);
            const columnName = String(name);
            return {
                filterable: settings.filterable && (column.filterable ?? true),
                name: columnName,
                value: filter ? filter[columnName] ?? '' : '',
                onChange: onChangeFilter,
            };
        },
        [columns, filter, onChangeFilter, settings.filterable]
    );

    /**
     * ソートボタンのクリックイベントハンドラーを返す
     */
    const getSortButtonClickEventHandler = useCallback(
        (name: keyof T) => {
            return () => {
                if (!settings.sortable) {
                    return;
                }

                const columnName = String(name);

                // 1. ソートボタンをクリックした順にソート順を保持する
                //    同じボタンが複数クリックされた場合はまず該当ソート順を削除してから
                //    先頭にソート順を登録する
                const order = sort.find((e) => e.name === columnName)?.order;
                const newSort: SortState[] = sort.filter((e) => e.name !== columnName);
                newSort.unshift({
                    name: columnName,
                    order: order === 'desc' ? 'asc' : 'desc',
                });

                const newData = clone(data);
                // 選択の解除
                clearSelection(newData, selection);
                // カレントセルの解除
                if (currentCell) {
                    newData[currentCell.row][currentCell.column].current = false;
                }

                // 2. ソート順を新しいヤツから順に適用する
                newData.sort((a, b) => {
                    for (const { name, order } of newSort) {
                        const column = columns.find((c) => c.name === name);
                        const aValue = a.find((e) => e.entityName === column.name).value;
                        const bValue = b.find((e) => e.entityName === column.name).value;
                        return compareValue(aValue, bValue, column.valueType, order);
                    }
                    return 0;
                });

                // 3. stateの更新
                setSort(newSort);
                setData(newData);
                setSelection([]);
                setCurrentCell(undefined);
            };
        },
        [columns, currentCell, data, selection, settings.sortable, sort]
    );

    /**
     * ソートボタンに設定する props を生成
     * @param name
     */
    const getSortProps = useCallback(
        (name: keyof T): SortProps => {
            const column = columns.find((c) => c.name === name);
            const columnName = String(name);
            return {
                sortable: settings.sortable && (column.sortable ?? true),
                order: sort.find((e) => e.name === columnName)?.order,
                onClick: getSortButtonClickEventHandler(name),
            };
        },
        [columns, getSortButtonClickEventHandler, settings.sortable, sort]
    );

    /**
     * セルのクリック
     * @param event
     * @param rowIndex
     * @param colIndex
     */
    const onCellClick = useCallback(
        (event: MouseEvent, rowIndex: number, colIndex: number) => {
            // 全体を通しての行番号
            const row = rowIndex + currentPage * perPage;
            // 選択セルの位置
            const location: CellLocation = { row, column: colIndex };

            // カレントセルと同じセルをクリックした？
            if (currentCell && compareLocation(currentCell, location) === 0) {
                // 何もせず終了
                return;
            }
            debug('onCellClick', location);

            const newData = clone(data);
            // 編集中に別のセルをクリック
            if (editCell) {
                // 更新を確定
                commitEditing(newData);
            }

            const newSelection: CellLocation[] = [];
            if (currentCell && event.shiftKey) {
                // シフトキーを押しながらセルクリック -> 範囲選択
                // カレントセルは変更しない
                const selections = selectRange(newData, currentCell, location);
                newSelection.push(...selections);
            } else {
                // 単一選択
                newSelection.push(location);
                setCurrentCell(location);
            }

            setData(newData);
            setSelection(newSelection);
        },
        [commitEditing, currentCell, currentPage, data, editCell, perPage]
    );

    /**
     * セルのダブルクリック
     */
    const onCellDoubleClick = useCallback(
        (_: MouseEvent, rowIndex: number, colIndex: number) => {
            // 全体を通しての行番号
            const row = rowIndex + currentPage * perPage;
            // 選択セルの位置
            const location: CellLocation = { row, column: colIndex };
            debug('onCellDoubleClick', location);
            // 編集モードで該当セルの編集開始
            startEditing(location, undefined, 'edit');
        },
        [currentPage, perPage, startEditing]
    );

    /**
     * マウスでのセル範囲選択
     */
    const onCellMouseOver = useCallback(
        (location: CellLocation) => {
            // 選択範囲を更新
            const newData = clone(data);
            // 選択状態を解除
            clearSelection(newData, selection);
            // 範囲選択
            const selections = selectRange(newData, currentCell, location);
            // state更新
            setSelection(selections);
            setData(newData);
        },
        [currentCell, data, selection]
    );

    /**
     * 行頭のセルをクリック
     * @param event
     * @param rowIndex
     */
    const onRowClick = useCallback(
        (event: MouseEvent, rowIndex: number) => {
            // 全体を通しての行番号
            const row = rowIndex + currentPage * perPage;

            const newData = clone(data);

            // 編集中だった場合
            if (editCell) {
                // 更新を確定
                commitEditing(newData);
            }

            // 選択状態を解除
            clearSelection(newData, selection);
            const newSelection: CellLocation[] = [];

            if (currentCell && event.shiftKey) {
                // シフトキーを押しながらセルクリック -> 範囲選択
                // カレントセルは変更しない
                const rangeStart: CellLocation = {
                    row: currentCell.row,
                    column: columnHead,
                };
                const rangeEnd: CellLocation = {
                    row,
                    column: columnTail,
                };
                const selections = selectRange(newData, rangeStart, rangeEnd);
                newSelection.push(...selections);
            } else {
                // 単一行選択
                const rangeStart: CellLocation = { row, column: columnHead };
                const rangeEnd: CellLocation = {
                    row,
                    column: columnTail,
                };
                const selections = selectRange(newData, rangeStart, rangeEnd);
                newSelection.push(...selections);

                // 前のカレントセルを解除
                if (currentCell) {
                    newData[currentCell.row][currentCell.column].current = false;
                }

                // 選択行の先頭をカレントセルとする
                if (newSelection.length > 0) {
                    const loc = newSelection[0];
                    newData[loc.row][loc.column].current = true;
                    setCurrentCell(loc);
                }
            }

            setData(newData);
            setSelection(newSelection);
        },
        [
            columnHead,
            columnTail,
            commitEditing,
            currentCell,
            currentPage,
            data,
            editCell,
            perPage,
            selection,
        ]
    );

    /**
     * 行の範囲選択
     */
    const onRowMouseOver = useCallback(
        (location: CellLocation) => {
            // 選択範囲を更新
            const newData = clone(data);
            // 選択状態を解除
            clearSelection(newData, selection);
            // 範囲選択
            const selections = selectRange(newData, currentCell, location);
            // state更新
            setSelection(selections);
            setData(newData);
        },
        [currentCell, data, selection]
    );

    /**
     * セルに設定する props を生成
     * @param cell
     * @param rowIndex
     * @param colIndex
     */
    const getCellProps = useCallback(
        (cell: Cell<T>, rowIndex: number, colIndex: number) => ({
            /**
             * 入力モード
             */
            mode,
            /**
             * セルのダブルクリック
             */
            onDoubleClick: (event: MouseEvent) => {
                // ダブルクリック処理
                onCellDoubleClick(event, rowIndex, colIndex);
            },
            /**
             * セルのクリック / ドラッグの開始
             * @param event
             */
            onMouseDown: (event: MouseEvent) => {
                if (event.button === MouseButton.Primary) {
                    // クリック時の処理
                    onCellClick(event, rowIndex, colIndex);
                    // ドラッグ開始
                    setDragging(true);
                }
            },
            /**
             * ドラッグ中
             * @param event
             */
            onMouseOver: () => {
                if (dragging && !Boolean(editCell)) {
                    // 全体を通しての行番号
                    const row = rowIndex + currentPage * perPage;
                    // 現在セルの位置
                    const location: CellLocation = { row, column: colIndex };
                    debug('mouse over', location);

                    // 範囲選択
                    onCellMouseOver(location);
                }
            },
            /**
             * ドラッグ終了
             */
            onMouseUp: () => {
                // 全体を通しての行番号
                const row = rowIndex + currentPage * perPage;
                // 現在セルの位置
                const location: CellLocation = { row, column: colIndex };
                debug('mouse up', location);
                // ドラッグ終了
                setDragging(false);
            },
        }),
        [
            currentPage,
            dragging,
            editCell,
            mode,
            onCellClick,
            onCellDoubleClick,
            onCellMouseOver,
            perPage,
        ]
    );

    /**
     * 行頭セルに設定する props を生成
     * @param rowIndex
     */
    const getRowHeaderCellProps = useCallback(
        (rowIndex: number): RowHeaderCellProps => ({
            onMouseDown: (event: MouseEvent) => {
                // 全体を通しての行番号
                const row = rowIndex + currentPage * perPage;
                // 現在セルの位置
                const location: CellLocation = { row, column: columnHead };
                debug('row mouse down', location);

                // クリック時の処理
                onRowClick(event, rowIndex);

                // ドラッグ開始
                setDraggingRow(true);
            },
            onMouseOver: (event: MouseEvent) => {
                if (draggingRow) {
                    // 全体を通しての行番号
                    const row = rowIndex + currentPage * perPage;
                    // 現在セルの位置
                    const location: CellLocation = { row, column: columnTail };
                    debug('row mouse over', location);

                    // 選択範囲を更新
                    onRowMouseOver(location);
                }
            },
            onMouseUp: () => {
                // 全体を通しての行番号
                const row = rowIndex + currentPage * perPage;
                // 現在セルの位置
                const location: CellLocation = { row, column: 0 };
                debug('row mouse up', location);
                // ドラッグ終了
                setDraggingRow(false);
            },
        }),
        [columnHead, columnTail, currentPage, draggingRow, onRowClick, onRowMouseOver, perPage]
    );

    /**
     * 編集モードでのキーボード操作
     * @param event
     */
    const handleEditorKeyDown = useCallback(
        (event: KeyboardEvent) => {
            // IME変換中は無視
            if (event.nativeEvent.isComposing) {
                return;
            }

            const keys: string[] = [];
            let action: EditorKeyDownAction = undefined;
            if (event.shiftKey) {
                keys.push('shift');
            } else if (event.ctrlKey) {
                keys.push('ctrl');
            } else if (event.metaKey) {
                keys.push('command');
            }

            debug(`handleEditorKeyDown: ${event.key}`);
            // 範囲選択モード中にキー入力があった場合、範囲選択モードをキャンセル
            let newMode = mode;
            if (mode === 'select') {
                newMode = 'normal';
            }

            let isArrowKey = false;
            switch (event.key) {
                case 'Tab':
                    keys.push('tab');
                    action = 'commit';
                    break;
                case 'Enter':
                    keys.push('enter');
                    action = 'commit';
                    break;
                case 'Escape':
                    action = 'cancel';
                    break;
            }

            if (mode === 'input') {
                // 入力モード時
                switch (event.key) {
                    case 'ArrowLeft':
                        isArrowKey = true;
                        keys.push('left');
                        action = 'commit';
                        break;
                    case 'ArrowRight':
                        isArrowKey = true;
                        keys.push('right');
                        action = 'commit';
                        break;
                    case 'ArrowUp':
                        isArrowKey = true;
                        keys.push('up');
                        action = 'commit';
                        break;
                    case 'ArrowDown':
                        isArrowKey = true;
                        keys.push('down');
                        action = 'commit';
                        break;
                    case 'F2':
                        newMode = 'edit';
                        break;
                }
            }

            if (mode === 'edit' && event.key === 'F2') {
                // 編集 -> 入力モード
                newMode = 'input';
            }

            if (action) {
                if (action === 'commit') {
                    const key = keys.join('+');
                    if (isArrowKey) {
                        if (event.shiftKey) {
                            keyDownShiftArrow(key);
                        } else {
                            keyDownArrow(key);
                        }
                    } else if (key === 'ctrl+enter' || key === 'command+enter') {
                        editMultipleCells();
                    } else {
                        keyDownTabEnter(key);
                    }
                }
                if (action === 'cancel') {
                    cancelEditing();
                }
                event.preventDefault();
            }

            if (mode !== newMode) {
                setMode(newMode);
            }
        },
        [cancelEditing, keyDownArrow, keyDownShiftArrow, editMultipleCells, keyDownTabEnter, mode]
    );

    /**
     * 編集セルの props を生成
     */
    const getEditorProps = useCallback(
        (): EditorProps => ({
            value: editCell?.value ?? '',
            onChange: (event: ChangeEvent<{ value: string }>) => {
                const { value } = event.target;
                setEditCell({
                    ...editCell,
                    value,
                });
            },
            onKeyDown: handleEditorKeyDown,
            cancel: cancelEditing,
            commit,
        }),
        [cancelEditing, commit, editCell, handleEditorKeyDown]
    );

    /**
     * ページ変更
     * @param event
     * @param newPage
     */
    const onChangePage = useCallback(
        (_: unknown, newPage: number) => {
            setPage(newPage);
            // カレントセル、選択状態をクリアする
            clearSelectionAndCurrentCell();
        },
        [clearSelectionAndCurrentCell]
    );

    /**
     * ページあたりの行数を変更
     * @param event
     */
    const onChangeRowsPerPage = useCallback(
        (event: ChangeEvent<HTMLSelectElement>) => {
            const { value } = event.target;
            const v = parseInt(value, 10);
            if (!Number.isNaN(v)) {
                setPage(0);
                setRowsPerPage(v);
                // カレントセル、選択状態をクリアする
                clearSelectionAndCurrentCell();
            }
        },
        [clearSelectionAndCurrentCell]
    );

    /**
     * 行追加
     */
    const insertRow = useCallback(
        (rowIndex?: number) => {
            if (readOnly) {
                return;
            }

            const insertRowNumber = typeof rowIndex === 'number' ? rowIndex + 1 : data?.length ?? 0;
            const newData = clone(data ?? []);
            const newRow = makeNewRow(insertRowNumber, newData);

            if (typeof rowIndex === 'number') {
                // 行番号指定時は挿入
                newData.splice(insertRowNumber, 0, newRow);
            } else {
                // 未指定時は追加
                newData.push(newRow);
            }

            // 挿入行にフォーカスを設定する
            const location: CellLocation = {
                row: insertRowNumber,
                column: columnHead,
            };

            // 挿入行のページを取得
            const newPage = getPageNumberFromRowIndex(location.row);

            setCurrentCell(location);
            setSelection([location]);
            setData(newData);
            setFocus(true);
            setPage(newPage);

            handleChange(newData);
            pushUndoList(newData);
        },
        [
            columnHead,
            data,
            getPageNumberFromRowIndex,
            handleChange,
            makeNewRow,
            pushUndoList,
            readOnly,
        ]
    );

    /**
     * 選択セルの下 / 最下部に新規行を追加する
     */
    const onInsertRow = useCallback(() => {
        insertRow(currentCell?.row);
    }, [currentCell?.row, insertRow]);

    /**
     * 行削除
     */
    const deleteRows = useCallback(() => {
        if (readOnly) {
            return;
        }
        if (selection.length === 0) {
            return;
        }

        const rows = selection.map((s) => s.row);
        const min = Math.min(...rows);
        const max = Math.max(...rows);
        const count = max - min + 1;
        // ${max - min + 1}件 のデータを削除します。よろしいですか？
        const message = formatMessage(messages, 'deleteConfirm', { count: `${count}` });
        if (window.confirm(message)) {
            const newData = clone(data);

            // 選択状態の解除
            clearSelection(newData, selection);
            if (currentCell) {
                // カレントセルのクリア
                newData[currentCell.row][currentCell.column].current = false;
            }

            // 削除
            newData.splice(min, count);

            setCurrentCell(undefined);
            setSelection([]);
            setData(newData);
            setFocus(false);

            handleChange(newData);
            pushUndoList(newData);
        }
    }, [currentCell, data, handleChange, messages, pushUndoList, readOnly, selection]);

    /**
     * 選択セルを削除する
     */
    const onDeleteRows = useCallback(() => {
        deleteRows();
    }, [deleteRows]);

    /**
     * locationを指定して値を更新
     */
    const onChangeCellValue = useCallback(
        (location: CellLocation, value: string) => {
            debug('onChangeCellValue: ', location, value);
            const cells = clone(data);
            if (setCellValue(value, location, cells)) {
                handleChange(cells);
                // 履歴更新
                pushUndoList(cells);
                // 更新確定
                setData(cells);
            }
        },
        [data, handleChange, pushUndoList, setCellValue]
    );

    /**
     * key, value を指定して該当行を表示する
     */
    const selectByKeyValue = useCallback(
        (key: keyof T, value: string): boolean => {
            debug(`selectByKeyValue: key=${String(key)}, value=${value}`);

            // 編集を完了する
            const cells = clone(data);
            if (editCell) {
                commitEditing(cells);
            }

            // 対象列を取得
            const columnIndex = columns.findIndex(({ name }) => name === key);
            if (columnIndex < 0) {
                return false;
            }
            // 対象行を取得
            const rowIndex = cells.findIndex((row) => row[columnIndex].value === value);
            if (rowIndex < 0) {
                return false;
            }

            // 選択解除
            clearSelection(cells, selection);
            // カレントセルの変更
            if (currentCell) {
                cells[currentCell.row][currentCell.column].current = false;
            }
            const newCurrentCell: CellLocation = {
                row: rowIndex,
                column: cells[rowIndex][columnIndex].hidden ? columnHead : columnIndex,
            };
            cells[newCurrentCell.row][newCurrentCell.column].current = true;
            cells[newCurrentCell.row][newCurrentCell.column].selected = true;

            // 表示ページを切り替え
            const newPage = Math.floor(rowIndex / perPage);
            setPage(newPage);

            // stateの更新
            setData(cells);
            setSelection([newCurrentCell]);
            setCurrentCell(newCurrentCell);

            return true;
        },
        [columnHead, columns, commitEditing, currentCell, data, editCell, perPage, selection]
    );

    return {
        emptyRows,
        page: currentPage,
        pageItems: displayItems,
        allItems: data,
        total: filteredData.length,
        lastPage: last,
        hasPrev: currentPage !== 0,
        hasNext: currentPage !== last,
        rowsPerPage: perPage,
        rowsPerPageOptions,
        selectedRange,
        tbodyRef,
        hasFocus: focus,
        onChangeCellValue,
        onChangePage,
        onChangeRowsPerPage,
        onDeleteRows,
        onInsertRow,
        onSelect,
        onSelectAll,
        getFilterProps,
        getSortProps,
        getCellProps,
        getRowHeaderCellProps,
        getEditorProps,
        selectByKeyValue,
        getSelectedCellValues,
        pasteData,
        setFocus,
        mode,
        setMode,
    };
};
