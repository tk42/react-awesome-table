import React, { useMemo } from 'react';
import { ProviderProps } from './types';

export type MessageFunction = (params: Record<string, string>) => string;

export const defaultMessages = {
    // header
    addRow: '+',
    deleteRows: '-',
    // hook
    deleteConfirm: ({ count }: { count: string }): string =>
        `Delete ${count} row(s)`,
    // pagination
    'pagination.first': '<<',
    'pagination.prev': '<',
    'pagination.next': '>',
    'pagination.last': '>>',
    // sort
    asc: '↑',
    desc: '↓',
    // フィルタ
    filter: 'filter',
    // validate
    'validate.required': 'Required field',
    'validate.numeric': 'Numeric field',
    'validate.datalist': ({ list }: { list: string }): string =>
        `Specify among ${list}`,
    'validate.unique': 'Duplicated field',
    // コピー＆ペースト
    copy: 'copy',
    paste: 'paste',
    select: 'select',
};

export type MessageDefinitions = Partial<
    Record<keyof typeof defaultMessages, string | MessageFunction>
>;

export const MessageContext = React.createContext<MessageDefinitions>(defaultMessages);

/**
 * メッセージ変換
 * @param messages
 * @param key
 * @param params
 * @returns
 */
export const formatMessage = (
    messages: MessageDefinitions,
    key: keyof MessageDefinitions,
    params: Record<string, string> = {}
): string => {
    const value = messages[key];
    if (typeof value === 'string') {
        return value;
    } else {
        return value(params);
    }
};

interface Props extends ProviderProps {
    messages: MessageDefinitions;
}

const MessageProvider: React.VFC<Props> = ({ messages, children }) => {
    const values = useMemo(() => {
        return {
            ...defaultMessages,
            ...messages,
        };
    }, [messages]);

    return <MessageContext.Provider value={values}>{children}</MessageContext.Provider>;
};

export default MessageProvider;
