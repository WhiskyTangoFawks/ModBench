using System.Text.Json;
using MEditService.Api;
using MEditService.Api.Endpoints;
using MEditService.Core.Edits;
using MEditService.Tests.Edits;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Api;

/// <summary>A record the codec cannot read answers the same at every write door: both copy endpoints
/// map the refusal to the status and the typed extension the edit endpoint maps it to.</summary>
public sealed class ParseFailedRefusalStatusTests : IDisposable
{
    private const int RefusedStatus = 422;

    private readonly CopyFixture _mod = CopyFixture.Create(trackSource: true);

    // Parse status comes from the codec at edit time (ADR-0015 invariant 5), so the record every
    // door here refuses is one whose document on disk the codec cannot read.
    public ParseFailedRefusalStatusTests()
    {
        var path = _mod.SourceFileFor(_mod.SourcePlugin, _mod.SourceNpc, "npc_", CopyFixture.SourceNpcEditorId);
        File.WriteAllText(
            path,
            File.ReadAllText(path).Replace(
                "\"EditorID\"", "\"MajorRecordFlagsRaw\": \"notanumber\",\n  \"EditorID\"", StringComparison.Ordinal));
    }

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void EditRecord_OfADocumentTheCodecCannotRead_IsAProblemNamingTheRefusal()
    {
        var request = new RecordEditRequest(
            CopyFixture.SourcePluginName, CopyFixture.SourceOrigin, RecordEditEnvelope.Set,
            [PathHop.Member("HeightMax")], JsonDocument.Parse("0.75").RootElement);

        var result = RecordEndpoints.EditRecord(
            _mod.SourceNpc.ToString(), request, _mod.EditHandler, NullLogger.Instance);

        AssertRefused(result);
    }

    [Fact]
    public void CopyRecordAsOverride_OfARecordTheCodecCannotRead_IsTheSameProblemAsARefusedEdit()
    {
        var request = new RecordCopyAsOverrideRequest(
            CopyFixture.SourcePluginName, CopyFixture.SourceOrigin,
            CopyFixture.DestinationPluginName, CopyFixture.DestinationOrigin);

        var result = RecordEndpoints.CopyRecordAsOverride(
            _mod.SourceNpc.ToString(), request, _mod.CopyAsOverrideHandler, NullLogger.Instance);

        AssertRefused(result);
        Assert.Empty(_mod.DestinationGitStatus());
    }

    [Fact]
    public void CopyRecordAsNewRecord_OfARecordTheCodecCannotRead_IsTheSameProblemAsARefusedEdit()
    {
        var request = new RecordCopyAsNewRecordRequest(
            CopyFixture.SourcePluginName, CopyFixture.SourceOrigin,
            CopyFixture.DestinationPluginName, CopyFixture.DestinationOrigin, RequestedFormKey: null);

        var result = RecordEndpoints.CopyRecordAsNewRecord(
            _mod.SourceNpc.ToString(), request, _mod.CopyAsNewHandler, NullLogger.Instance);

        AssertRefused(result);
        Assert.Empty(_mod.DestinationGitStatus());
    }

    private static void AssertRefused(IResult result)
    {
        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(RefusedStatus, problem.StatusCode);
        Assert.Equal(
            nameof(RecordEditRefusal.RecordParseFailed),
            Assert.Contains("refusal", problem.ProblemDetails.Extensions));
        // The reader's own words, which is the only thing that says why.
        Assert.Contains("Unable to cast", problem.ProblemDetails.Detail!, StringComparison.Ordinal);
    }
}
