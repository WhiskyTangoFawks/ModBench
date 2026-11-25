using System.Text.Json;
using MEditService.Commands.Edits;
using MEditService.Commands.Tests.TestSupport;
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

    [Theory]
    [InlineData(false, """["Small"]""", RecordEditRefusal.SyntheticMemberIndirectWrite, true)]
    [InlineData(true, """["Small", "Master"]""", RecordEditRefusal.None, false)]
    public void ARawFlagsWrite_IsRefused_OnlyWhereItChangesTheLightFlag(bool light, string flags, RecordEditRefusal refusal, bool namesTheLightFlag)
    {
        Assert.True(Service().Set(_fixture.Plugin, HeaderFormKey, "IsSmallMaster", Json(light)).Applied);

        var result = Service().Set(_fixture.Plugin, HeaderFormKey, "Flags", JsonDocument.Parse(flags).RootElement);

        Assert.Equal(
            (refusal, namesTheLightFlag),
            (result.Refusal, result.Message?.Contains("IsSmallMaster", StringComparison.Ordinal) == true));
    }
}
