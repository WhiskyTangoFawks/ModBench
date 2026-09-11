using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>Forged corruption, as in <c>BinaryRoundTripGateTests</c>: no real tracked-source
/// corruption exists to lift into TestData. A corrupt FormKey in source JSON throws
/// <c>FilePathedException</c> wrapping <see cref="ArgumentException"/>, not <c>RecordException</c>.</summary>
public sealed class PluginCompileServiceDiagnosisTests : IDisposable
{
    private readonly CompileFixture _mod = new();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void Compile_WhenTheTrackedSourceHoldsAMalformedFormKey_NamesTheSourceFileNotJustTheRawExceptionText()
    {
        Corrupt(_mod.NpcSourceFile);

        var compileService = _mod.CompileService();
        var result = compileService.Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains("Npcs", result.RefusalReason);
        Assert.Contains("FixtureNpc", result.RefusalReason);
        Assert.Contains("Malformed FormKey string: NOT-A-FORMKEY", result.RefusalReason);
        Assert.Contains(PluginDiagnosis.UnknownClass, result.RefusalReason);
        Assert.Contains("Re-Track to regenerate the source.", result.RefusalReason);
    }

    // Mod-folder relative, so the named file joins straight onto the mod folder for the Problems
    // panel, whichever source the compile read.
    [Fact]
    public void Compile_WhenTheWorkingTreeHoldsAMalformedFormKey_NamesTheFileRelativeToTheModFolder()
    {
        Corrupt(_mod.NpcSourceFile);

        var result = _mod.CompileService().Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains(
            Path.GetRelativePath(_mod.ModFolder, _mod.NpcSourceFile), result.RefusalReason, StringComparison.Ordinal);
    }

    [Fact]
    public void Compile_WhenTheCompiledRefHoldsAMalformedFormKey_NamesTheFileRelativeToTheModFolder()
    {
        var healthy = File.ReadAllText(_mod.NpcSourceFile);
        Corrupt(_mod.NpcSourceFile);
        _mod.CommitWorkingTree("a malformed FormKey");
        File.WriteAllText(_mod.NpcSourceFile, healthy);

        var result = _mod.CompileService().Compile(_mod.Plugin, new CompileSource.AtRef("HEAD"));

        Assert.False(result.Succeeded);
        Assert.Contains(
            Path.GetRelativePath(_mod.ModFolder, _mod.NpcSourceFile), result.RefusalReason, StringComparison.Ordinal);
    }

    private void Corrupt(string sourceFile) =>
        File.WriteAllText(
            sourceFile,
            File.ReadAllText(sourceFile).Replace(_mod.Race.ToString(), "NOT-A-FORMKEY", StringComparison.Ordinal));
}
