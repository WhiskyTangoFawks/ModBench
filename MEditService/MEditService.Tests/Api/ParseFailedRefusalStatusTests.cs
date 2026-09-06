using System.Text.Json;
using DuckDB.NET.Data;
using MEditService.Api.Endpoints;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Api;

/// <summary>A parse-failed record answers the same at every write door: both copy endpoints map
/// the refusal to the status and the typed extension the edit endpoint maps it to.</summary>
public sealed class ParseFailedRefusalStatusTests : IDisposable
{
    private const int RefusedStatus = 422;
    private const string Diagnosis = "the subrecord was cut short";

    private readonly CopyFixture _mod = CopyFixture.Create(trackSource: true);
    private readonly RecordEditService _edits;

    public ParseFailedRefusalStatusTests()
    {
        using (var cmd = ((DuckDbRecordIndex)_mod.Mirror.Index!).Connection.CreateCommand())
        {
            cmd.CommandText = "UPDATE mirror.records SET parse_diagnosis = $1 WHERE form_key = $2";
            cmd.Parameters.Add(new DuckDBParameter { Value = Diagnosis });
            cmd.Parameters.Add(new DuckDBParameter { Value = _mod.SourceNpc.ToString() });
            cmd.ExecuteNonQuery();
        }
        _edits = new RecordEditService(_mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);
    }

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void EditRecord_OfAParseFailedRecord_IsAProblemNamingTheRefusal()
    {
        var request = new RecordEditRequest(
            CopyFixture.SourcePluginName, CopyFixture.SourceOrigin, RecordEditEnvelope.Set,
            [PathHop.Member("HeightMax")], JsonDocument.Parse("0.75").RootElement);

        var result = RecordEndpoints.EditRecord(
            _mod.SourceNpc.ToString(), request, _edits, _mod.Mirror.WriteGate, NullLogger.Instance);

        AssertRefused(result);
    }

    [Fact]
    public void CopyRecordAsOverride_OfAParseFailedRecord_IsTheSameProblemAsARefusedEdit()
    {
        var request = new RecordCopyAsOverrideRequest(
            CopyFixture.SourcePluginName, CopyFixture.SourceOrigin,
            CopyFixture.DestinationPluginName, CopyFixture.DestinationOrigin);

        var result = RecordEndpoints.CopyRecordAsOverride(
            _mod.SourceNpc.ToString(), request, _edits, _mod.Mirror.WriteGate, NullLogger.Instance);

        AssertRefused(result);
    }

    [Fact]
    public void CopyRecordAsNewRecord_OfAParseFailedRecord_IsTheSameProblemAsARefusedEdit()
    {
        var request = new RecordCopyAsNewRecordRequest(
            CopyFixture.SourcePluginName, CopyFixture.SourceOrigin,
            CopyFixture.DestinationPluginName, CopyFixture.DestinationOrigin, RequestedFormKey: null);

        var result = RecordEndpoints.CopyRecordAsNewRecord(
            _mod.SourceNpc.ToString(), request, _edits, _mod.Mirror.WriteGate, NullLogger.Instance);

        AssertRefused(result);
    }

    private static void AssertRefused(IResult result)
    {
        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(RefusedStatus, problem.StatusCode);
        Assert.Equal(
            nameof(RecordEditRefusal.RecordParseFailed),
            Assert.Contains("refusal", problem.ProblemDetails.Extensions));
        Assert.Contains(Diagnosis, problem.ProblemDetails.Detail!, StringComparison.Ordinal);
    }
}
