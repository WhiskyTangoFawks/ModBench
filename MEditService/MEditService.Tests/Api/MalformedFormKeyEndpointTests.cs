using MEditService.Api;
using MEditService.Api.Endpoints;
using MEditService.Core.Commands;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Tests.Edits;
using MEditService.Tests.TestSupport;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Api;

/// <summary>At the endpoint layer, not the service: <c>FormKey.Factory</c> throws
/// <see cref="ArgumentException"/> on malformed input, and the fix is the endpoint's own catch
/// (400), not a new <c>RecordEditRefusal</c> case (422).</summary>
public sealed class MalformedFormKeyEndpointTests
{
    private const string MalformedFormKey = "not-a-formkey";

    private static RenumberRecordHandler RenumberHandlerFor(IndexedModFixture mod) => TestEditService.RenumberHandler(mod.Holder);

    private static CreateRecordHandler CreateHandlerFor(IndexedModFixture mod) => TestEditService.CreateHandler(mod.Holder);

    private static CopyRecordAsNewRecordHandler CopyAsNewHandlerFor(IndexedModFixture mod) =>
        TestEditService.CopyAsNewHandler(mod.Holder);

    [Fact]
    public void CreateRecord_MalformedTypedFormKey_Returns400_NotAnUnhandledException()
    {
        using var mod = IndexedModFixture.Tracked();
        var req = new RecordCreateRequest(IndexedModFixture.ModFolderOrigin, "npc_", "Broken", MalformedFormKey);

        var result = PluginEndpoints.CreateRecord(mod.Plugin.Name, req, CreateHandlerFor(mod), mod.Index.WriteGate, NullLoggerFactory.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
    }

    [Fact]
    public void RenumberRecord_MalformedTypedFormKey_Returns400_NotAnUnhandledException()
    {
        using var mod = IndexedModFixture.Tracked();
        var req = new RecordRenumberRequest(mod.Plugin.Name, IndexedModFixture.ModFolderOrigin, MalformedFormKey);

        var result = RecordEndpoints.RenumberRecord(mod.Npc.ToString(), req, RenumberHandlerFor(mod), mod.Index.WriteGate, NullLogger.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
    }

    [Fact]
    public void CopyRecordAsNewRecord_MalformedTypedFormKey_Returns400_NotAnUnhandledException()
    {
        using var mod = IndexedModFixture.Tracked();
        var req = new RecordCopyAsNewRecordRequest(
            mod.Plugin.Name, IndexedModFixture.ModFolderOrigin,
            mod.Plugin.Name, IndexedModFixture.ModFolderOrigin, MalformedFormKey);

        var result = RecordEndpoints.CopyRecordAsNewRecord(
            mod.Npc.ToString(), req, CopyAsNewHandlerFor(mod), mod.Index.WriteGate, NullLogger.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
    }
}
