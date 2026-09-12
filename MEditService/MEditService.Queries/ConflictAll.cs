using System.Text.Json.Serialization;

namespace MEditService.Queries;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ConflictAll
{
    OnlyOne,
    NoConflict,
    Override,
    Conflict,
    ConflictCritical,
}
