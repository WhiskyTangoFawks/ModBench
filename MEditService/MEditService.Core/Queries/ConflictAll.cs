using System.Text.Json.Serialization;

namespace MEditService.Core.Queries;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ConflictAll
{
    OnlyOne,
    NoConflict,
    Override,
    Conflict,
    ConflictCritical,
}
