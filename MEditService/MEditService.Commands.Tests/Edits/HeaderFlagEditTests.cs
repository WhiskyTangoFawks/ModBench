using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Commands.Tests.Edits;

public sealed class HeaderFlagEditTests : IDisposable
{
    private readonly SourceEditFixture _fixture = SourceEditFixture.Tracked();

    public void Dispose() => _fixture.Dispose();

    private TestEditor Service() => _fixture.EditHandler;

    private static string HeaderFormKey => FormKey.Factory($"000000:{SourceEditFixture.PluginName}").ToString();

    private static JsonElement Json(bool value) => JsonDocument.Parse(value ? "true" : "false").RootElement;

    [Fact]
    public async Task EditField_IsLightTrue_SetsTheSmallFlag_AndCompilesItIntoTheBinary()
    {
        var result = Service().Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(true));

        Assert.True(result.Applied, result.Message);

        Assert.Contains("Small", _fixture.Document(HeaderFormKey).Require().Body, StringComparison.Ordinal);

        await CompileServices.Over(_fixture.LoadOrder).CompileLandedAsync(_fixture.Plugin);

        using var written = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(SourceEditFixture.PluginName),
                Path.Combine(_fixture.ModFolder, SourceEditFixture.PluginName)),
            GameRelease.Fallout4);
        Assert.True(((IModFlagsGetter)written).IsSmallMaster);
    }

    [Fact]
    public async Task Compile_WithTheLightFlagAndAnOutOfRangeRecord_IsRefused_NamingTheRecordAndTheRemedies()
    {
        TrackedTree.Seed(_fixture.ModFolder, _fixture.Plugin, $"001000:{SourceEditFixture.PluginName}");
        Assert.True(Service().Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(true)).Applied);

        var answer = await CompileService().CompileAsync([_fixture.Plugin]);

        Assert.Empty(answer.Landed);
        var refused = Assert.Single(answer.Refused);
        Assert.Equal(
            (CompileRefusal.FormIdOutsideFlagLimit,
             $"{SourceEditFixture.PluginName} is a light plugin but holds native FormID(s) outside the light range (0x0-0xFFF): " +
             $"001000:{SourceEditFixture.PluginName}. Clear the light flag, or change the records' FormIDs."),
            (refused.Refusal, refused.Message));
    }

    [Fact]
    public async Task Compile_OfAnEslWithAnOutOfRangeRecord_NamesRenamingItOffEslAmongTheRemedies()
    {
        using var light = SourceEditFixture.TrackedLight("Fixture.esl");
        TrackedTree.Seed(light.ModFolder, light.Plugin, "001000:Fixture.esl");

        var refused = Assert.Single((await CompileServices.Over(light.LoadOrder).CompileAsync([light.Plugin])).Refused);

        Assert.EndsWith(". Clear the light flag, rename the plugin off .esl, or change the records' FormIDs.", refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_OfAnOutOfRangeRecord_Succeeds_OnceTheLightFlagIsCleared()
    {
        TrackedTree.Seed(_fixture.ModFolder, _fixture.Plugin, $"001000:{SourceEditFixture.PluginName}");
        Assert.True(Service().Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(true)).Applied);
        Assert.True(Service().Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(false)).Applied);

        await CompileService().CompileLandedAsync(_fixture.Plugin);
    }

    private CompilePluginHandler CompileService() =>
        CompileServices.Over(_fixture.LoadOrder);

    private RecordEditResult SetFlags(string names) =>
        Service().Set(_fixture.Plugin, HeaderFormKey, "Flags", JsonDocument.Parse(names).RootElement);

    [Fact]
    public void EditField_RawFlagsSettingSmall_IsRefusedNamingTheLightFlagsDoor()
    {
        var result = SetFlags("[\"Small\"]");

        Assert.False(result.Applied);
        Assert.Equal(RecordEditRefusal.SyntheticMemberIndirectWrite, result.Refusal);
        Assert.Contains("IsSmallMaster", result.Message, StringComparison.Ordinal);
        Assert.Empty(_fixture.ChangedFormKeys());
    }

    [Fact]
    public void EditField_RawFlagsLeavingSmallAsItIs_WhileChangingAnotherBit_IsAccepted()
    {
        Assert.True(Service().Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(true)).Applied);

        var result = SetFlags("[\"Small\", \"Master\"]");

        Assert.True(result.Applied, result.Message);
        Assert.True(HeaderDocument.Read(System.Text.Encoding.UTF8.GetBytes(_fixture.Document(HeaderFormKey).Require().Body), GameRelease.Fallout4).IsSmallMaster);
    }

    [Fact]
    public async Task EditField_Author_CompilesIntoTheBinary()
    {
        Assert.True(Service().Set(_fixture.Plugin, HeaderFormKey, "Author", JsonDocument.Parse("\"Someone\"").RootElement).Applied);

        await CompileService().CompileLandedAsync(_fixture.Plugin);

        using var written = ModFactory.ImportGetter(
            new ModPath(ModKey.FromFileName(SourceEditFixture.PluginName),
                Path.Combine(_fixture.ModFolder, SourceEditFixture.PluginName)),
            GameRelease.Fallout4);
        Assert.Equal("Someone", ((IFallout4ModGetter)written).ModHeader.Author);
    }
}
