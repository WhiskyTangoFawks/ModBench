using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>A record whose document could not be produced at index time has a stub body, and a
/// write to it is refused with the diagnosis as the reason: nothing can be patched onto a stub.</summary>
public sealed class ParseFailedEditRefusalTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void Edit_OfARecordThatFailedToParse_IsRefusedWithItsDiagnosis_AndWritesNothing()
    {
        using (var cmd = ((DuckDbRecordIndex)_mod.Mirror.Index!).Connection.CreateCommand())
        {
            cmd.CommandText = "UPDATE mirror.records SET parse_diagnosis = 'the subrecord was cut short' WHERE form_key = $1";
            cmd.Parameters.Add(new DuckDBParameter { Value = _mod.Npc.ToString() });
            cmd.ExecuteNonQuery();
        }
        var service = new RecordEditService(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

        var result = service.Set(_mod.Plugin, _mod.Npc.ToString(), "HeightMax", JsonDocument.Parse("0.75").RootElement);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.RecordParseFailed, result.Refusal);
        Assert.Contains("the subrecord was cut short", result.Message, StringComparison.Ordinal);
        Assert.Empty(_mod.GitStatus());
    }
}
