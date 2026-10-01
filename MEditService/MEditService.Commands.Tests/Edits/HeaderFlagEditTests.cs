using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

/// <summary>The ESL flag's one sanctioned write door is the synthetic <c>IsSmallMaster</c> header field;
/// the raw <c>flags</c> column stays read-only.</summary>
public sealed class HeaderFlagEditTests : IDisposable
{
    private readonly SourceEditFixture _fixture = SourceEditFixture.Tracked();

    public void Dispose() => _fixture.Dispose();

    private EditRecordHandler Service() => _fixture.EditHandler;

    private static string HeaderFormKey => FormKey.Factory($"000000:{SourceEditFixture.PluginName}").ToString();

    private static JsonElement Json(bool value) => JsonDocument.Parse(value ? "true" : "false").RootElement;

    [Fact]
    public async Task EditField_IsLightTrue_SetsTheSmallFlag_AndCompilesItIntoTheBinary()
    {
        var result = Service().Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(true));

        Assert.True(result.Applied, result.Message);

        // The source document is the truth: the root RecordData.json now carries the flag.
        Assert.Contains("Small", _fixture.Document(HeaderFormKey).Require().Body, StringComparison.Ordinal);

        var compile = await CompileServices.Over(_fixture.LoadOrder)
            .CompileAsync(_fixture.Plugin);
        Assert.True(compile.Succeeded, compile.RefusalReason);

        using var written = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(SourceEditFixture.PluginName),
                Path.Combine(_fixture.ModFolder, SourceEditFixture.PluginName)),
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
        Assert.DoesNotContain("Small", _fixture.Document(HeaderFormKey).Require().Body, StringComparison.Ordinal);
    }

    // The allocator answers from the document, not the load order's in-memory mod object: a flag
    // flipped this session caps FormID minting immediately, with no reconcile in between.
    [Fact]
    public void AfterSettingIsLight_ATypedTargetOutsideTheLightRange_IsRefusedImmediately()
    {
        Assert.True(Service().Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(true)).Applied);

        var result = _fixture.CreateHandler.CreateRecord(
            _fixture.Plugin, "npc_", "OutOfRange", $"001000:{SourceEditFixture.PluginName}");

        Assert.False(result.Applied);
        Assert.Contains("0xFFF", result.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WithTheLightFlagAndAnOutOfRangeRecord_IsRefused_NamingTheRecordAndTheThreeRemedies()
    {
        Assert.True(_fixture.CreateHandler.CreateRecord(
            _fixture.Plugin, "npc_", "BigId", $"001000:{SourceEditFixture.PluginName}").Applied);
        Assert.True(Service().Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(true)).Applied);

        var compile = await CompileService().CompileAsync(_fixture.Plugin);

        Assert.False(compile.Succeeded);
        Assert.Contains("001000", compile.RefusalReason, StringComparison.Ordinal);
        Assert.EndsWith(
            "Clear the light flag, rename the plugin off .esl, or change the records' FormIDs.",
            compile.RefusalReason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_OfAnOutOfRangeRecord_Succeeds_OnceTheLightFlagIsCleared()
    {
        Assert.True(_fixture.CreateHandler.CreateRecord(
            _fixture.Plugin, "npc_", "BigId", $"001000:{SourceEditFixture.PluginName}").Applied);
        Assert.True(Service().Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(true)).Applied);
        Assert.True(Service().Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(false)).Applied);

        var compile = await CompileService().CompileAsync(_fixture.Plugin);

        Assert.True(compile.Succeeded, compile.RefusalReason);
    }

    private PluginCompileService CompileService() =>
        CompileServices.Over(_fixture.LoadOrder);

    [Fact]
    public void EditField_Masters_RefusesAsReadOnly_AndChangesNothing()
    {
        var masters = Service().Set(
            _fixture.Plugin, HeaderFormKey, "MasterReferences", JsonDocument.Parse("[\"Other.esm\"]").RootElement);

        Assert.Equal(RecordEditRefusal.FieldReadOnly, masters.Refusal);
        Assert.Empty(_fixture.GitStatus());
    }
}
