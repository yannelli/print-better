import { Children, cloneElement, isValidElement, type ReactNode } from 'react'

/** Docs write the server address as this token. The docs site shows the address the reader is on. */
export const ORIGIN_TOKEN = 'https://your-print-better.example'

export function withOrigin(text: string, origin = location.origin): string {
  return text.includes(ORIGIN_TOKEN) ? text.split(ORIGIN_TOKEN).join(origin) : text
}

/** Replaces the token in every text node of rendered MDX, such as the spans of highlighted code. */
export function replaceOrigin(node: ReactNode, origin = location.origin): ReactNode {
  if (typeof node === 'string') return withOrigin(node, origin)
  if (Array.isArray(node)) return Children.map(node, (child) => replaceOrigin(child, origin))
  if (!isValidElement<{ children?: ReactNode }>(node) || node.props.children === undefined) return node
  return cloneElement(node, { children: replaceOrigin(node.props.children, origin) })
}
