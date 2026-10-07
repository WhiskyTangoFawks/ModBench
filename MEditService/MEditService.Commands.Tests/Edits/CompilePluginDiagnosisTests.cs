using MEditService.Codec.Serialization;
using MEditService.Commands.Tests.TestSupport;
using MEditService.TestSupport;

namespace MEditService.Commands.Tests.Edits;

public sealed class CompilePluginDiagnosisTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public async Task Compile_WhenTheTrackedSourceHoldsAMalformedFormKey_NamesTheRecordNotJustTheRawExceptionText()
    {
        Corrupt();

        var compileService = _mod.CompileService();
        var answer = await compileService.CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Contains("FixtureNpc", refused.Message);
        Assert.Contains("Malformed FormKey string: NOT-A-FORMKEY", refused.Message);
        Assert.Contains(PluginDiagnosis.UnknownClass, refused.Message);
        Assert.Contains("Decompile the plugin to regenerate the source.", refused.Message);
    }

    [Fact]
    public async Task Compile_WhenTheWorkingTreeHoldsAMalformedFormKey_NamesTheFileRelativeToTheModFolder()
    {
        var file = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        Corrupt();

        var answer = await _mod.CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolder, file), refused.Message, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WhenTheHeaderIsMalformed_NamesTheHeadersFileAsTheLayoutSpellsIt()
    {
        File.WriteAllText(Path.Combine(_mod.ModFolder, PluginSourceRoot.HeaderDocument(_mod.Plugin.Name)), "{ \"ModKey\": \"Compile.esp\", \"ModHeader\": { \"Stats\": { \"Version\": \"x\" } } }");

        var answer = await _mod.CompileService().CompileAsync([_mod.Plugin]);

        var refused = Assert.Single(answer.Refused);
        Assert.Contains(PluginSourceRoot.HeaderDocument(_mod.Plugin.Name), refused.Message, StringComparison.Ordinal);
    }

    private void Corrupt() =>
        _mod.Overwrite(
            _mod.NpcIdentity,
            _mod.Document(_mod.Npc.ToString()).Require().Body.Replace(_mod.Race.ToString(), "NOT-A-FORMKEY", StringComparison.Ordinal));
}
