using System.Text.Json.Serialization;

namespace MEditService.Index.Queries;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ConflictAll
{
    OnlyOne,
    NoConflict,
    Override,
    Conflict,
}
