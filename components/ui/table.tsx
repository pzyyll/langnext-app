import { View, type JSX } from "nsh";
import {
  Table as BaseTable,
  TableBody as BaseTableBody,
  TableCell as BaseTableCell,
  TableHead as BaseTableHead,
  TableHeader as BaseTableHeader,
  TableRow as BaseTableRow,
} from "nsh/base";

export function Table(props: {
  accessibilityLabel?: string;
  class?: string;
  children?: JSX.Element;
}) {
  return (
    <View
      class={`overflow-hidden rounded-lg border border-border bg-background ${props.class ?? ""}`}
    >
      <BaseTable accessibilityLabel={props.accessibilityLabel}>{props.children}</BaseTable>
    </View>
  );
}

export function TableHeader(props: { class?: string; children?: JSX.Element }) {
  return (
    <BaseTableHeader class={`border-b border-border bg-muted/60 ${props.class ?? ""}`}>
      {props.children}
    </BaseTableHeader>
  );
}

export function TableBody(props: { class?: string; children?: JSX.Element }) {
  return <BaseTableBody class={props.class}>{props.children}</BaseTableBody>;
}

export function TableRow(props: { class?: string; testID?: string; children?: JSX.Element }) {
  return (
    <BaseTableRow
      testID={props.testID}
      class={`flex-row items-center gap-2 border-b border-border px-3 py-2 last:border-b-0 ${props.class ?? ""}`}
    >
      {props.children}
    </BaseTableRow>
  );
}

export function TableHead(props: { class?: string; children?: JSX.Element }) {
  return <BaseTableHead class={props.class}>{props.children}</BaseTableHead>;
}

export function TableCell(props: { class?: string; children?: JSX.Element }) {
  return <BaseTableCell class={props.class}>{props.children}</BaseTableCell>;
}
