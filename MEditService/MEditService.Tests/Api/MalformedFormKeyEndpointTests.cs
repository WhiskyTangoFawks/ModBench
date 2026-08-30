using MEditService.Api.Endpoints;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Tests.Edits;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Api;

/// <summary>
/// #502: a malformed caller-typed FormKey (xEdit's own typed-FormID path, #427) on any of the three
/// gestures that route it through <c>RecordEditService.RefuseIfNotNativeTarget</c> —
/// <see cref="RecordEditService.CreateRecord"/>, <see cref="RecordEditService.RenumberRecord"/> and
/// <see cref="RecordEditService.CopyRecordAsNewRecord"/> — must come back as a graceful 400
/// <c>ProblemDetails</c>, the same shape <c>PluginEndpoints.CreatePlugin</c> already uses for its own
/// <see cref="ArgumentException"/>, not an unhandled exception escaping the endpoint.
///
/// <c>Mutagen.Bethesda.Plugins.FormKey.Factory(string)</c> throws <see cref="ArgumentException"/> on
/// malformed input (wrong shape, non-hex, missing <c>:</c>) with no <c>TryFactory</c>/try-catch guard
/// at that call site (<c>RecordEditService.RefuseIfNotNativeTarget</c>) — these tests are at the
/// endpoint layer, not the service layer, because the fix is the endpoint's own catch, not a new
/// <c>RecordEditRefusal</c> case (the malformed-syntax/well-formed-but-refused distinction 400 vs 422
/// already draws elsewhere on this write path).
/// </summary>
public sealed class MalformedFormKeyEndpointTests
{
    private const string MalformedFormKey = "not-a-formkey";

    private static RecordEditService ServiceFor(TrackedModFixture mod) =>
        new(mod.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    [Fact]
    public void CreateRecord_MalformedTypedFormKey_Returns400_NotAnUnhandledException()
    {
        using var mod = TrackedModFixture.Tracked();
        var req = new RecordCreateRequest(TrackedModFixture.ModFolderOrigin, "npc_", "Broken", MalformedFormKey);

        var result = PluginEndpoints.CreateRecord(mod.Plugin.Name, req, ServiceFor(mod), NullLoggerFactory.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
    }

    [Fact]
    public void RenumberRecord_MalformedTypedFormKey_Returns400_NotAnUnhandledException()
    {
        using var mod = TrackedModFixture.Tracked();
        var req = new RecordRenumberRequest(mod.Plugin.Name, TrackedModFixture.ModFolderOrigin, MalformedFormKey);

        var result = RecordEndpoints.RenumberRecord(mod.Npc.ToString(), req, ServiceFor(mod), NullLogger.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
    }

    [Fact]
    public void CopyRecordAsNewRecord_MalformedTypedFormKey_Returns400_NotAnUnhandledException()
    {
        using var mod = TrackedModFixture.Tracked();
        var req = new RecordCopyAsNewRecordRequest(
            mod.Plugin.Name, TrackedModFixture.ModFolderOrigin,
            mod.Plugin.Name, TrackedModFixture.ModFolderOrigin, MalformedFormKey);

        var result = RecordEndpoints.CopyRecordAsNewRecord(mod.Npc.ToString(), req, ServiceFor(mod), NullLogger.Instance);

        var problem = Assert.IsAssignableFrom<ProblemHttpResult>(result);
        Assert.Equal(400, problem.StatusCode);
    }
}
