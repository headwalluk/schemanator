/**
 * Flattening expanded JSON-LD, in-house.
 *
 * **Amendment A in `dev-notes/00`: do not use `jsonld.flatten`.** Two reasons,
 * both fatal to requirements set elsewhere:
 *
 *   - It discards the JSON pointer, and `01` makes provenance mandatory on
 *     every node with no exceptions. A finding you cannot trace to exact source
 *     is unreportable, and unfixable by the operator.
 *   - It relabels blank nodes `_:b0`, `_:b1` per document. Those labels shift
 *     when unrelated markup changes, which breaks the stable blank-node scheme
 *     in `01` and therefore breaks run-to-run diffing — the thing `05`'s
 *     fix-verify loop depends on.
 *
 * `jsonld.expand` still does the spec-heavy work: context resolution, full
 * IRIs, arrays everywhere. Post-expansion, flattening is a recursive hoist of
 * nested node objects leaving `{"@id": …}` references behind. Small, and the
 * only route to pointer provenance and stable blank ids.
 */

import type { ExtractedNode, Syntax } from './types.ts';

/** JSON pointer escaping, RFC 6901. Property IRIs contain `/` constantly. */
function escapePointerToken(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function isValueObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && '@value' in (value as object);
}

function isListObject(value: unknown): boolean {
  return value !== null && typeof value === 'object' && '@list' in (value as object);
}

/**
 * A node object in expanded form: an object that is neither a literal value nor
 * a list wrapper. `@id`-only objects count — they are references, and the
 * caller decides what to do with them.
 */
function isNodeObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return !isValueObject(value) && !isListObject(value);
}

/** A bare `{"@id": …}` with nothing else. A pointer, not an observation (`04` rule 1). */
export function isReferenceOnly(node: Record<string, unknown>): boolean {
  const keys = Object.keys(node);
  return keys.length === 1 && keys[0] === '@id';
}

export interface FlattenOptions {
  pageId: string;
  syntax: Syntax;
  block: number;
  /**
   * Maps a resolved `@id` back to the string the author actually wrote, when
   * the two differ. Amendment C — see `ExtractedNode.raw_id`.
   */
  rawIds?: ReadonlyMap<string, string>;
}

/**
 * Blank-node identity, per `01`: `_:<page_id>/<syntax>/<block>/<pointer>`.
 *
 * Stable across runs while the markup is unchanged, which is what makes
 * run-to-run diffing possible.
 *
 * An author-supplied `_:label` is namespaced rather than replaced. Replacing it
 * positionally would break identity: two references to the same `_:foo` inside
 * one document would become two different nodes, silently fracturing a graph
 * the author had wired up correctly.
 */
function blankNodeId(options: FlattenOptions, pointer: string, authorLabel?: string): string {
  const prefix = `_:${options.pageId}/${options.syntax}/${options.block}`;
  return authorLabel === undefined ? `${prefix}${pointer}` : `${prefix}/${authorLabel}`;
}

/**
 * Flatten an expanded JSON-LD document into nodes.
 *
 * @param expanded Output of `jsonld.expand` — always a top-level array.
 */
export function flattenExpanded(expanded: unknown[], options: FlattenOptions): ExtractedNode[] {
  const nodes: ExtractedNode[] = [];
  /** Merge repeated definitions of one `@id` within a single block. */
  const byId = new Map<string, ExtractedNode>();

  /** Hoist a node and return the reference that replaces it in its parent. */
  const hoist = (raw: Record<string, unknown>, pointer: string): { '@id': string } => {
    const declaredId = typeof raw['@id'] === 'string' ? raw['@id'] : undefined;
    const isBlank = declaredId === undefined || declaredId.startsWith('_:');

    const nodeId = isBlank
      ? blankNodeId(options, pointer, declaredId?.startsWith('_:') ? declaredId.slice(2) : undefined)
      : (declaredId as string);

    const types = (Array.isArray(raw['@type']) ? raw['@type'] : raw['@type'] === undefined ? [] : [raw['@type']])
      .filter((type): type is string => typeof type === 'string');

    const props: Record<string, unknown[]> = {};

    for (const [key, value] of Object.entries(raw)) {
      if (key === '@id' || key === '@type') continue;

      const values = Array.isArray(value) ? value : [value];
      props[key] = values.map((item, index) =>
        walkValue(item, `${pointer}/${escapePointerToken(key)}/${index}`),
      );
    }

    const existing = byId.get(nodeId);
    if (existing !== undefined) {
      // The same @id defined twice inside one block. Union rather than
      // clobber: dropping either half would lose an observation, and RDF says
      // both statements hold.
      for (const type of types) if (!existing.types.includes(type)) existing.types.push(type);
      for (const [key, values] of Object.entries(props)) {
        existing.props[key] = [...(existing.props[key] ?? []), ...values];
      }
      return { '@id': nodeId };
    }

    const rawId = options.rawIds?.get(nodeId);
    const node: ExtractedNode = {
      node_id: nodeId,
      raw_id: rawId !== undefined && rawId !== nodeId ? rawId : null,
      is_blank: isBlank,
      page_id: options.pageId,
      types,
      props,
      source: { syntax: options.syntax, block: options.block, pointer },
    };

    byId.set(nodeId, node);
    nodes.push(node);
    return { '@id': nodeId };
  };

  /** Replace nested nodes with references; leave literals and lists in place. */
  const walkValue = (value: unknown, pointer: string): unknown => {
    if (Array.isArray(value)) {
      return value.map((item, index) => walkValue(item, `${pointer}/${index}`));
    }

    if (isListObject(value)) {
      const list = (value as Record<string, unknown>)['@list'];
      const items = Array.isArray(list) ? list : [list];
      return {
        '@list': items.map((item, index) => walkValue(item, `${pointer}/@list/${index}`)),
      };
    }

    // A literal. Keep it exactly as expansion produced it — @value, @type and
    // @language all carry meaning a check might need.
    if (isValueObject(value)) return value;

    if (isNodeObject(value)) {
      const node = value as Record<string, unknown>;
      // A bare reference stays a reference. Hoisting it would manufacture an
      // empty observation of the entity, which is precisely rule 1 in `04`.
      if (isReferenceOnly(node)) return node;
      return hoist(node, pointer);
    }

    return value;
  };

  expanded.forEach((entry, index) => {
    if (isNodeObject(entry)) {
      const node = entry as Record<string, unknown>;
      if (!isReferenceOnly(node)) hoist(node, `/${index}`);
    }
  });

  return nodes;
}
