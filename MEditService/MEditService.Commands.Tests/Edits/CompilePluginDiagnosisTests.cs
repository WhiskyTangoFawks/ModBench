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
        var result = await compileService.CompileOneAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains("FixtureNpc", result.RefusalReason);
        Assert.Contains("Malformed FormKey string: NOT-A-FORMKEY", result.RefusalReason);
        Assert.Contains(PluginDiagnosis.UnknownClass, result.RefusalReason);
        Assert.Contains("Run \"Modbench: Decompile Plugin\" to regenerate the source.", result.RefusalReason);
    }

    [Fact]
    public async Task Compile_WhenTheWorkingTreeHoldsAMalformedFormKey_NamesTheFileRelativeToTheModFolder()
    {
        var file = TreeTampering.FileOf(_mod.ModFolder, _mod.Plugin, _mod.NpcIdentity);
        Corrupt();

        var result = await _mod.CompileService().CompileOneAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolder, file), result.RefusalReason, StringComparison.Ordinal);
    }

    [Fact]
    public async Task Compile_WhenTheHeaderIsMalformed_NamesTheHeadersFileAsTheLayoutSpellsIt()
    {
        File.WriteAllText(Path.Combine(_mod.ModFolder, PluginSourceRoot.HeaderDocument(_mod.Plugin.Name)), "{ \"ModKey\": \"Compile.esp\", \"ModHeader\": { \"Stats\": { \"Version\": \"x\" } } }");

        var result = await _mod.CompileService().CompileOneAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains(PluginSourceRoot.HeaderDocument(_mod.Plugin.Name), result.RefusalReason, StringComparison.Ordinal);
    }

    private void Corrupt() =>
        _mod.Overwrite(
            _mod.NpcIdentity,
            _mod.Document(_mod.Npc.ToString()).Require().Body.Replace(_mod.Race.ToString(), "NOT-A-FORMKEY", StringComparison.Ordinal));
}
