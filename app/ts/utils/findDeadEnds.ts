type Edge<T> = { from: bigint, to: bigint, data: T }

export function findDeadEnds<T>(edges: readonly Edge<T>[], startId: bigint): Map<bigint, Edge<T>[]> {
	const adjacencyList: Map<bigint, Edge<T>[]> = new Map()
	const visited: Set<bigint> = new Set()
	const deadEnds: Map<bigint, Edge<T>[]> = new Map()

	for (const edge of edges) {
		const outgoingEdges = adjacencyList.get(edge.from)
		if (outgoingEdges === undefined) adjacencyList.set(edge.from, [edge])
		else outgoingEdges.push(edge)
	}
	
	function depthFirstSearch(node: bigint, path: Edge<T>[]) {
		visited.add(node)

		const outgoingEdges = adjacencyList.get(node)
		if (outgoingEdges === undefined || outgoingEdges.length === 0) {
			deadEnds.set(node, [...path])
		} else {
			for (const neighbor of outgoingEdges) {
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
