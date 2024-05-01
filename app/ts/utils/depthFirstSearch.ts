type Edge<T> = { from: bigint, to: bigint, id: T }
type Graph<T> = Map<bigint, Array<Edge<T>>>

// Create a graph from edges
function buildGraph<T>(edges: readonly Edge<T>[]): Graph<T> {
	const graph = new Map<bigint, Array<Edge<T>>>()
	for (const edge of edges) {
		if (!graph.has(edge.from)) graph.set(edge.from, [])
		graph.get(edge.from)!.push(edge)
	}
	return graph
}

function depthFirstSearch<T>(node: bigint, graph: Graph<T>, visited: Set<bigint>, pathEdges: Edge<T>[], longestPathEdges: Edge<T>[]): void {
	visited.add(node)

	const neighbors = graph.get(node)
	if (neighbors) {
		for (const edge of neighbors) {
			if (visited.has(edge.to)) continue
			pathEdges.push(edge)
			if (pathEdges.length > longestPathEdges.length) {
				longestPathEdges.length = 0
				longestPathEdges.push(...pathEdges)
			}
			depthFirstSearch(edge.to, graph, visited, pathEdges, longestPathEdges)
			pathEdges.pop()
		}
	}

	// Backtrack
	visited.delete(node)
}

export function findLongestPathFromStart<T>(edges: readonly Edge<T>[], startNode: bigint): Edge<T>[] {
	const graph = buildGraph(edges)
	const visited = new Set<bigint>()
	const pathEdges: Edge<T>[] = []
	const longestPathEdges: Edge<T>[] = []
	depthFirstSearch(startNode, graph, visited, pathEdges, longestPathEdges)
	return longestPathEdges
}
