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
        var npcFile = _mod.NpcSourceFile;
        var original = File.ReadAllText(npcFile);
        File.WriteAllText(npcFile, original.Replace(_mod.Race.ToString(), "NOT-A-FORMKEY", StringComparison.Ordinal));

        var compileService = _mod.CompileService();
        var result = compileService.Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains("Npcs", result.RefusalReason);
        Assert.Contains("FixtureNpc", result.RefusalReason);
        Assert.Contains("Malformed FormKey string: NOT-A-FORMKEY", result.RefusalReason);
        Assert.Contains(PluginDiagnosis.UnknownClass, result.RefusalReason);
        Assert.Contains("Re-Track to regenerate the source.", result.RefusalReason);
    }
}
