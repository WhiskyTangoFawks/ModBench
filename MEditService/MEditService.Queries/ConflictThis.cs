using System.Text.Json.Serialization;

namespace MEditService.Queries;

[JsonConverter(typeof(JsonStringEnumConverter))]
public enum ConflictThis
{
    OnlyOne,
    Master,
    IdenticalToMaster,
    Override,
    ConflictWins,
    ConflictLoses,
}
