using MEditService.Api.Endpoints;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Schema;
using MEditService.Tests.Edits;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Api;

/// <summary>The batch copy door's HTTP mapping (#550 AC6/Q4) — the semantics themselves are
/// <c>CopyOverwriteTests</c>' service-level coverage; this pins the wire shape: a refused batch is
/// a 200 with the structured refusal, never a ProblemDetails, and an empty batch is a 400.</summary>
public sealed class BatchCopyEndpointTests : IDisposable
{
    private readonly ContainerCopyFixture _fixture = ContainerCopyFixture.Create();

    public void Dispose() => _fixture.Dispose();

    private RecordEditService Service() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    [Fact]
    public void EmptyBatch_Returns400()
    {
        var result = RecordEndpoints.CopyRecordsBatch(new BatchCopyRequest([]), Service(), NullLogger.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
    }

    [Fact]
    public void RefusedBatch_ReturnsTheStructuredBody_NotAProblem()
    {
        var request = new BatchCopyRequest(
        [
            new BatchCopyItemRequest(
                ContainerCopyFixture.SourcePluginName, ContainerCopyFixture.SourceOrigin,
                _fixture.InteriorCell.ToString(),
                ContainerCopyFixture.DestinationPluginName, ContainerCopyFixture.DestinationOrigin,
                AsNewRecord: true, RequestedFormKey: null),
        ]);

        var result = RecordEndpoints.CopyRecordsBatch(request, Service(), NullLogger.Instance);

        var ok = Assert.IsAssignableFrom<Ok<BatchCopyResponse>>(result);
        var body = ok.Value!;
        Assert.False(body.Applied);
        Assert.Equal(_fixture.InteriorCell.ToString(), body.RefusedFormKey);
        Assert.Equal(nameof(RecordEditRefusal.CopyAsNewRecordDisallowedForType), body.Refusal);
        Assert.Empty(body.Results);
    }
}
