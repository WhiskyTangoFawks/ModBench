using MEditService.Codec.Serialization;

namespace MEditService.Commands.Tests.Edits;

public sealed class PluginCompileServiceDiagnosisTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public async Task Compile_WhenTheTrackedSourceHoldsAMalformedFormKey_NamesTheSourceFileNotJustTheRawExceptionText()
    {
        Corrupt(_mod.NpcSourceFile);

        var compileService = _mod.CompileService();
        var result = await compileService.CompileAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains("Npcs", result.RefusalReason);
        Assert.Contains("FixtureNpc", result.RefusalReason);
        Assert.Contains("Malformed FormKey string: NOT-A-FORMKEY", result.RefusalReason);
        Assert.Contains(PluginDiagnosis.UnknownClass, result.RefusalReason);
        Assert.Contains("Re-Track to regenerate the source.", result.RefusalReason);
    }

    [Fact]
    public async Task Compile_WhenTheWorkingTreeHoldsAMalformedFormKey_NamesTheFileRelativeToTheModFolder()
    {
        Corrupt(_mod.NpcSourceFile);

        var result = await _mod.CompileService().CompileAsync(_mod.Plugin);

        Assert.False(result.Succeeded);
        Assert.Contains(
            Path.GetRelativePath(_mod.ModFolder, _mod.NpcSourceFile), result.RefusalReason, StringComparison.Ordinal);
    }

    private void Corrupt(string sourceFile) =>
        File.WriteAllText(
            sourceFile,
            File.ReadAllText(sourceFile).Replace(_mod.Race.ToString(), "NOT-A-FORMKEY", StringComparison.Ordinal));
}
