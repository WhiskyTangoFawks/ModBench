using System.Text.Json;
using MEditService.Codec.Serialization;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Tests.Edits;

public sealed class HeaderFlagEditTests : IDisposable
{
    private readonly SourceEditFixture _fixture = SourceEditFixture.CompiledPlugin();

    public void Dispose() => _fixture.Dispose();

    private TestEditor Service() => _fixture.EditHandler;

    private static string HeaderFormKey => FormKey.Factory($"000000:{SourceEditFixture.PluginName}").ToString();

    private static JsonElement Json(bool value) => JsonDocument.Parse(value ? "true" : "false").RootElement;

    [Fact]
    public async Task Compile_WithTheLightFlagAndAnOutOfRangeRecord_IsRefused_NamingTheRecord()
    {
        SourceModTree.Seed(_fixture.ModFolder, _fixture.Plugin, $"001000:{SourceEditFixture.PluginName}");
        Assert.True(Service().Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(true)).Applied);

        var answer = (await _fixture.CompileHandler.CompileAsync([_fixture.Plugin])).Value();

        Assert.Empty(answer.Applied);
        var refused = Assert.Single(answer.Refused);
        Assert.Equal(CompileRefusal.FormIdOutsideFlagLimit, refused.Refusal);
        Assert.Contains($"001000:{SourceEditFixture.PluginName}", refused.Message, StringComparison.Ordinal);
    }

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
}
