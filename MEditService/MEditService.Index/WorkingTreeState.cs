using System.Text.Json.Serialization;

namespace MEditService.Index;

// A tri-state rather than two booleans: the states are mutually exclusive, and a future Deleted
// would be a wire addition, not a reshape. Deleted is absent because a working-tree-deleted
// record has no Search() row to describe.
[JsonConverter(typeof(JsonStringEnumConverter))]
public enum WorkingTreeState { None, Modified, Added }
