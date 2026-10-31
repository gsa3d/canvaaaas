// Группы слоёв, как папки в Photoshop. Слой знает свою группу (group), группа — ту, в которой лежит она сама. Своего места
// в стопке у группы нет: её слои лежат в стопке подряд, и где они, там и она; группа без слоёв уходит сама (liveGroups).
// Перестановки считаются над деревом: buildTree → правка списков → flatten, поэтому слои группы всегда остаются подряд.
// Части слоя и заплатки фона под ним (из старых проектов) — не узлы: они ездят со своим слоем.
import type { DocGroup, DocObject } from './document.ts';

export type GroupNode = { kind: 'group'; group: DocGroup; children: LayerNode[] };
/** Слой с тем, что ездит с ним (members — снизу вверх, сам он среди них), или группа; дети — сверху вниз */
export type LayerNode = { kind: 'layer'; obj: DocObject; members: DocObject[] } | GroupNode;

export function nodeId(node: LayerNode): string {
  return node.kind === 'layer' ? node.obj.id : node.group.id;
}

/** Группа, в которой лежит группа g; цепочки с петлёй обрываются — такая группа в корне */
function parentsOf(groups: DocGroup[]): Map<string, string | undefined> {
  const byId = new Map(groups.map((g) => [g.id, g]));
  const out = new Map<string, string | undefined>();
  for (const g of groups) {
    const seen = new Set([g.id]);
    let p = g.group;
    for (let cur = p; cur !== undefined; cur = byId.get(cur)?.group) {
      if (seen.has(cur) || !byId.has(cur)) {
        p = undefined;
        break;
      }
      seen.add(cur);
    }
    out.set(g.id, p);
  }
  return out;
}

/** Слой, с которым ездит часть или заплатка фона (у остальных — он сам) */
function ownerOf(o: DocObject, byId: Map<string, DocObject>): DocObject {
  let cur = o;
  for (let i = 0; i < 64; i++) {
    const next = cur.kind === 'fill' ? (cur.under ? byId.get(cur.under) : undefined) : cur.parent ? byId.get(cur.parent) : undefined;
    if (!next || next === o || next.kind === 'fill') return cur;
    cur = next;
  }
  return cur;
}

/** Дерево слоёв и групп сверху вниз; слои группы, лежащие не подряд, собираются туда, где её верхний слой */
export function buildTree(objects: DocObject[], groups: DocGroup[]): LayerNode[] {
  const byId = new Map(objects.map((o) => [o.id, o]));
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const parents = parentsOf(groups);
  const layers = new Map<string, Extract<LayerNode, { kind: 'layer' }>>();
  for (const o of objects) {
    const owner = ownerOf(o, byId);
    let node = layers.get(owner.id);
    if (!node) layers.set(owner.id, (node = { kind: 'layer', obj: owner, members: [] }));
    node.members.push(o);
  }
  const roots: LayerNode[] = [];
  const groupNodes = new Map<string, GroupNode>();
  const childrenOf = (id: string): LayerNode[] => {
    const known = groupNodes.get(id);
    if (known) return known.children;
    const node: GroupNode = { kind: 'group', group: groupById.get(id)!, children: [] };
    groupNodes.set(id, node);
    const parent = parents.get(id);
    (parent ? childrenOf(parent) : roots).push(node);
    return node.children;
  };
  for (const o of [...objects].reverse()) {
    const node = layers.get(o.id);
    if (!node) continue;
    (o.group && groupById.has(o.group) ? childrenOf(o.group) : roots).push(node);
  }
  return roots;
}

/** Стопка слоёв снизу вверх и группы, в которых есть слои; у кого поменялась группа — новая запись, остальные те же */
export function flatten(tree: LayerNode[]): { objects: DocObject[]; groups: DocGroup[] } {
  const objects: DocObject[] = [];
  const groups: DocGroup[] = [];
  const walk = (list: LayerNode[], parent: string | undefined) => {
    for (const node of [...list].reverse()) {
      if (node.kind === 'layer') {
        for (const m of node.members) {
          // Группа — только у самого слоя: часть и заплатка видны или скрыты вместе с ним
          const group = m === node.obj ? parent : undefined;
          objects.push(m.group === group ? m : { ...m, group });
        }
      } else {
        const before = objects.length;
        walk(node.children, node.group.id);
        if (objects.length > before) groups.push(node.group.group === parent ? node.group : { ...node.group, group: parent });
      }
    }
  };
  walk(tree, undefined);
  return { objects, groups };
}

/** Группы, в которых есть хоть один слой (и те, в которых лежат они) */
export function liveGroups(objects: DocObject[], groups: DocGroup[]): DocGroup[] {
  const parents = parentsOf(groups);
  const live = new Set<string>();
  for (const o of objects) {
    for (let g = o.group && parents.has(o.group) ? o.group : undefined; g && !live.has(g); g = parents.get(g)) live.add(g);
  }
  return groups.filter((g) => live.has(g.id));
}

/** Где узел id: в каком списке, на каком месте и в какой группе (null — в корне) */
export function locate(tree: LayerNode[], id: string): { list: LayerNode[]; index: number; parent: string | null } | null {
  const walk = (list: LayerNode[], parent: string | null): ReturnType<typeof locate> => {
    for (let i = 0; i < list.length; i++) {
      const node = list[i]!;
      if (nodeId(node) === id) return { list, index: i, parent };
      if (node.kind === 'group') {
        const found = walk(node.children, node.group.id);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(tree, null);
}

/** Слои узла: сам слой или все слои группы со вложенными, сверху вниз */
export function layersOf(node: LayerNode): DocObject[] {
  return node.kind === 'layer' ? [node.obj] : node.children.flatMap(layersOf);
}

function inside(node: LayerNode, id: string): boolean {
  return nodeId(node) === id || (node.kind === 'group' && node.children.some((c) => inside(c, id)));
}

/**
 * Положить узел id в группу into (null — в корень) прямо над её узлом over (null — под всеми в ней). Дерево меняется на
 * месте; false — так нельзя (группа в саму себя) или ничего не меняется
 */
export function moveNode(tree: LayerNode[], id: string, into: string | null, over: string | null): boolean {
  const from = locate(tree, id);
  if (!from || over === id) return false;
  const node = from.list[from.index]!;
  let target = tree;
  if (into !== null) {
    if (inside(node, into)) return false;
    const g = locate(tree, into);
    const group = g?.list[g.index];
    if (group?.kind !== 'group') throw new Error('Нет такой группы');
    target = group.children;
  }
  if (over !== null && !target.some((n) => nodeId(n) === over)) throw new Error('Нет такого слоя в группе');
  // На своём месте: в той же группе прямо над тем же узлом
  const below = from.list[from.index + 1];
  if (from.list === target && (below ? nodeId(below) : null) === over) return false;
  from.list.splice(from.index, 1);
  const at = over === null ? target.length : target.findIndex((n) => nodeId(n) === over);
  target.splice(at, 0, node);
  return true;
}

/**
 * Узлы ids — в новую группу group: она встаёт туда, где был верхний из них, они в ней — в прежнем порядке. Узел,
 * который лежит в другом из ids, едет с ним
 */
export function groupNodes(tree: LayerNode[], ids: string[], group: DocGroup): GroupNode {
  const wanted = new Set(ids);
  const picked: LayerNode[] = [];
  const collect = (list: LayerNode[]) => {
    for (const node of list) {
      if (wanted.has(nodeId(node))) picked.push(node);
      else if (node.kind === 'group') collect(node.children);
    }
  };
  collect(tree);
  if (!picked.length) throw new Error('Нечего группировать: выберите слои');
  const top = locate(tree, nodeId(picked[0]!))!;
  // Пустая, пока остальные не убраны с прежних мест: иначе их нашли бы и в ней
  const node: GroupNode = { kind: 'group', group: { ...group, group: top.parent ?? undefined }, children: [] };
  top.list.splice(top.index, 1, node);
  for (const p of picked.slice(1)) {
    const at = locate(tree, nodeId(p))!;
    at.list.splice(at.index, 1);
  }
  node.children = picked;
  return node;
}

/** Разгруппировать: то, что было в группе, встаёт на её место */
export function ungroupNode(tree: LayerNode[], id: string): void {
  const at = locate(tree, id);
  const node = at?.list[at.index];
  if (node?.kind !== 'group') throw new Error('Нет такой группы');
  at!.list.splice(at!.index, 1, ...node.children);
}

/** Новый слой — сверху группы into (null — сверху всех) */
export function insertTop(tree: LayerNode[], obj: DocObject, into: string | null): void {
  let target = tree;
  if (into !== null) {
    const g = locate(tree, into);
    const group = g?.list[g.index];
    if (group?.kind === 'group') target = group.children;
  }
  target.unshift({ kind: 'layer', obj, members: [obj] });
}
