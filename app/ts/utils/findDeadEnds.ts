type Edge<T> = { from: bigint, to: bigint, data: T }

export function findDeadEnds<T>(Edges: readonly Edge<T>[], startId: bigint): Map<bigint, Edge<T>[]> {
	const adjacencyList: Map<bigint, Edge<T>[]> = new Map()
	const visited: Set<bigint> = new Set()
	const deadEnds: Map<bigint, Edge<T>[]> = new Map()

	for (const Edge of Edges) {
		if (!adjacencyList.has(Edge.from)) adjacencyList.set(Edge.from, [])
		adjacencyList.get(Edge.from)!.push(Edge)
	}
	
	function depthFirstSearch(node: bigint, path: Edge<T>[]) {
		visited.add(node)

		if (!adjacencyList.has(node) || adjacencyList.get(node)!.length === 0) {
			deadEnds.set(node, [...path])
		} else {
			for (const neighbor of adjacencyList.get(node)!) {
				if (!visited.has(neighbor.to)) {
					path.push(neighbor)
					depthFirstSearch(neighbor.to, path)
					path.pop()
				}
			}
		}
	}
	depthFirstSearch(startId, [])
	return deadEnds
}
