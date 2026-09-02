using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Tests.Edits;

/// <summary>
/// #290 — the ESL flag's one sanctioned write door: the synthetic <c>is_light</c> header field,
/// the same pattern <c>is_partial_form</c> already uses for record-flag bit 14. The header's raw
/// <c>flags</c> column stays read-only (full flags-array editing is a follow-up); this boolean is
/// what the flag lifecycle needs — creation defaults it on, the compile coherence prompt turns it
/// off, and a user can do either by hand from the header editor.
/// </summary>
public sealed class HeaderFlagEditTests : IDisposable
{
    private readonly TrackedModFixture _fixture = TrackedModFixture.Tracked();

    public void Dispose() => _fixture.Dispose();

    private RecordEditService Service() =>
        new(_fixture.Mirror, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance);

    private static string HeaderFormKey => FormKey.Factory($"000000:{TrackedModFixture.PluginName}").ToString();

    private static JsonElement Json(bool value) => JsonDocument.Parse(value ? "true" : "false").RootElement;

    [Fact]
    public void EditField_IsLightTrue_SetsTheSmallFlag_AndCompilesItIntoTheBinary()
    {
        var result = Service().EditField(_fixture.Plugin, HeaderFormKey, "is_light", Json(true));

        Assert.True(result.Applied, result.Message);

        // The source document is the truth: the root RecordData.json now carries the flag.
        var headerDoc = _fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(HeaderFormKey, _fixture.Plugin);
        Assert.Contains("Small", headerDoc!.Body!, StringComparison.Ordinal);

        var compile = new PluginCompileService(
                _fixture.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance)
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
        Assert.True(service.EditField(_fixture.Plugin, HeaderFormKey, "is_light", Json(true)).Applied);

        var result = service.EditField(_fixture.Plugin, HeaderFormKey, "is_light", Json(false));

        Assert.True(result.Applied, result.Message);
        var headerDoc = _fixture.Mirror.Index!.At(RecordRef.Effective).GetDocument(HeaderFormKey, _fixture.Plugin);
        Assert.DoesNotContain("Small", headerDoc!.Body!, StringComparison.Ordinal);
    }

    // The allocator answers from the document, not the load order's in-memory mod object: a flag
    // flipped this session caps FormID minting immediately, with no reconcile in between.
    [Fact]
    public void AfterSettingIsLight_ATypedTargetOutsideTheLightRange_IsRefusedImmediately()
    {
        var service = Service();
        Assert.True(service.EditField(_fixture.Plugin, HeaderFormKey, "is_light", Json(true)).Applied);

        var result = service.CreateRecord(
            _fixture.Plugin, "npc_", "OutOfRange", $"001000:{TrackedModFixture.PluginName}");

        Assert.False(result.Applied);
        Assert.Contains("0xFFF", result.Message, StringComparison.Ordinal);
    }

    // #290's compile-time coherence gate: an ESL-flagged plugin whose content no longer fits the
    // light range refuses to compile, with the typed EslContradiction marker the frontend turns
    // into the remove-the-flag prompt. Accepting that prompt is an ordinary is_light edit + a
    // second compile — which then succeeds.
    [Fact]
    public void Compile_WithTheEslFlagAndAnOutOfRangeRecord_RefusesWithTheContradictionMarker()
    {
        var service = Service();
        Assert.True(service.CreateRecord(
            _fixture.Plugin, "npc_", "BigId", $"001000:{TrackedModFixture.PluginName}").Applied);
        Assert.True(service.EditField(_fixture.Plugin, HeaderFormKey, "is_light", Json(true)).Applied);

        var compile = CompileService().Compile(_fixture.Plugin, new CompileSource.WorkingTree());

        Assert.False(compile.Succeeded);
        Assert.True(compile.EslContradiction);
        Assert.Contains("001000", compile.RefusalReason, StringComparison.Ordinal);

        // The accepted prompt's own path: clear the flag, compile again — clean.
        Assert.True(service.EditField(_fixture.Plugin, HeaderFormKey, "is_light", Json(false)).Applied);
        var second = CompileService().Compile(_fixture.Plugin, new CompileSource.WorkingTree());
        Assert.True(second.Succeeded, second.RefusalReason);
        Assert.False(second.EslContradiction);
    }

    private PluginCompileService CompileService() =>
        new(_fixture.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    // The raw flags column stays exactly as read-only as it was — is_light is the one door.
    [Fact]
    public void EditField_RawFlagsColumn_StillRefusesAsReadOnly()
    {
        var result = Service().EditField(
            _fixture.Plugin, HeaderFormKey, "flags", JsonDocument.Parse("[\"Small\"]").RootElement);

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.FieldReadOnly, result.Refusal);
    }
}
