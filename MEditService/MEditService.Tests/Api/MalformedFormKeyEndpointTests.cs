using MEditService.Api;
using MEditService.Api.Endpoints;
using MEditService.Tests.Edits;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Api;

/// <summary>At the endpoint layer, not the service: <c>FormKey.Factory</c> throws
/// <see cref="ArgumentException"/> on malformed input, and the fix is the endpoint's own catch
/// (400), not a new <c>RecordEditRefusal</c> case (422).</summary>
public sealed class MalformedFormKeyEndpointTests
{
    private const string MalformedFormKey = "not-a-formkey";

    [Fact]
    public void CreateRecord_MalformedTypedFormKey_Returns400_NotAnUnhandledException()
    {
        using var fx = SourceEditFixture.Tracked();
        var req = new RecordCreateRequest(SourceEditFixture.ModFolderOrigin, "npc_", "Broken", MalformedFormKey);

        var result = PluginEndpoints.CreateRecord(fx.Plugin.Name, req, fx.CreateHandler, NullLoggerFactory.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
    }

    [Fact]
    public void RenumberRecord_MalformedTypedFormKey_Returns400_NotAnUnhandledException()
    {
        using var fx = SourceEditFixture.Tracked();
        var req = new RecordRenumberRequest(fx.Plugin.Name, SourceEditFixture.ModFolderOrigin, MalformedFormKey);

        var result = RecordEndpoints.RenumberRecord(fx.Npc.ToString(), req, fx.RenumberHandler, NullLogger.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
    }

    [Fact]
    public void CopyRecordAsNewRecord_MalformedTypedFormKey_Returns400_NotAnUnhandledException()
    {
        using var fx = CopyFixture.Create(trackSource: true);
        var req = new RecordCopyAsNewRecordRequest(
            CopyFixture.SourcePluginName, CopyFixture.SourceOrigin,
            CopyFixture.DestinationPluginName, CopyFixture.DestinationOrigin, MalformedFormKey);

        var result = RecordEndpoints.CopyRecordAsNewRecord(
            fx.SourceNpc.ToString(), req, fx.CopyAsNewHandler, NullLogger.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
    }
}
