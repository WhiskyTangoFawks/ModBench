using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>The ESL flag's one sanctioned write door is the synthetic <c>IsSmallMaster</c> header field;
/// the raw <c>flags</c> column stays read-only.</summary>
public sealed class HeaderFlagEditTests : IDisposable
{
    private readonly TrackedModFixture _fixture = TrackedModFixture.Tracked();

    public void Dispose() => _fixture.Dispose();

    private ProjectingEditService Service() =>
        ProjectingEditService.Over(_fixture.Mirror);

    private static string HeaderFormKey => FormKey.Factory($"000000:{TrackedModFixture.PluginName}").ToString();

    private static JsonElement Json(bool value) => JsonDocument.Parse(value ? "true" : "false").RootElement;

    [Fact]
    public void EditField_IsLightTrue_SetsTheSmallFlag_AndCompilesItIntoTheBinary()
    {
        var result = Service().Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(true));

        Assert.True(result.Applied, result.Message);

        // The source document is the truth: the root RecordData.json now carries the flag.
        var headerDoc = _fixture.Mirror.Projected().GetDocument(HeaderFormKey, _fixture.Plugin);
        Assert.Contains("Small", headerDoc!.Body!, StringComparison.Ordinal);

        var compile = CompileServices.Over(_fixture.Mirror)
            .Compile(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(compile.Succeeded, compile.RefusalReason);

        using var written = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(TrackedModFixture.PluginName),
                Path.Combine(_fixture.ModFolder, TrackedModFixture.PluginName)),
            GameRelease.Fallout4);
        Assert.True(((IModFlagsGetter)written).IsSmallMaster);
    }

    [Fact]
    public void EditField_IsLightFalse_ClearsTheSmallFlag()
    {
        var service = Service();
        Assert.True(service.Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(true)).Applied);

        var result = service.Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(false));

        Assert.True(result.Applied, result.Message);
        var headerDoc = _fixture.Mirror.Projected().GetDocument(HeaderFormKey, _fixture.Plugin);
        Assert.DoesNotContain("Small", headerDoc!.Body!, StringComparison.Ordinal);
    }

    // The allocator answers from the document, not the load order's in-memory mod object: a flag
    // flipped this session caps FormID minting immediately, with no reconcile in between.
    [Fact]
    public void AfterSettingIsLight_ATypedTargetOutsideTheLightRange_IsRefusedImmediately()
    {
        var service = Service();
        Assert.True(service.Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(true)).Applied);

        var result = service.CreateRecord(
            _fixture.Plugin, "npc_", "OutOfRange", $"001000:{TrackedModFixture.PluginName}");

        Assert.False(result.Applied);
        Assert.Contains("0xFFF", result.Message, StringComparison.Ordinal);
    }

    // The compile-time coherence gate: an ESL-flagged plugin whose content overflows the light
    // range refuses to compile, with the typed EslContradiction marker the frontend turns into the
    // remove-the-flag prompt.
    [Fact]
    public void Compile_WithTheEslFlagAndAnOutOfRangeRecord_RefusesWithTheContradictionMarker()
    {
        var service = Service();
        Assert.True(service.CreateRecord(
            _fixture.Plugin, "npc_", "BigId", $"001000:{TrackedModFixture.PluginName}").Applied);
        Assert.True(service.Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(true)).Applied);

        var compile = CompileService().Compile(_fixture.Plugin, new CompileSource.WorkingTree());

        Assert.False(compile.Succeeded);
        Assert.True(compile.EslContradiction);
        Assert.Contains("001000", compile.RefusalReason, StringComparison.Ordinal);

        // The accepted prompt's own path: clear the flag, compile again — clean.
        Assert.True(service.Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(false)).Applied);
        var second = CompileService().Compile(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(second.Succeeded, second.RefusalReason);
        Assert.False(second.EslContradiction);
    }

    private PluginCompileService CompileService() =>
        CompileServices.Over(_fixture.Mirror);

    // The raw flags column stays exactly as read-only as it was — IsSmallMaster is the one door.
    [Fact]
    public void EditField_RawFlagsColumn_StillRefusesAsReadOnly()
    {
        var result = Service().Set(
            _fixture.Plugin, HeaderFormKey, "Flags", JsonDocument.Parse("[\"Small\"]").RootElement);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
    }

    // Masters and Author refuse identically to Flags — the evidence that no masters-specific
    // mechanism exists, only the shared absence of a write delegate on every header column.
    [Fact]
    public void EditField_MastersOrAuthor_RefusesAsReadOnly_LikeTheFlagsColumn()
    {
        var masters = Service().Set(
            _fixture.Plugin, HeaderFormKey, PluginHeader.MastersFieldName, JsonDocument.Parse("[\"Other.esm\"]").RootElement);
        var author = Service().Set(
            _fixture.Plugin, HeaderFormKey, "Author", JsonDocument.Parse("\"Someone Else\"").RootElement);

        Assert.Equal(RecordEditRefusal.FieldReadOnly, masters.Refusal);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, author.Refusal);
        Assert.Empty(_fixture.GitStatus());
    }
}
