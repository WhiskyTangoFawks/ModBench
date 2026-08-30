using MEditService.Core.Edits;
using MEditService.Core.Schema;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;

namespace MEditService.Tests.Edits;

/// <summary>
/// #519's diagnosis floor at Compile's own <c>DeserializeSource</c> seam, forged — the same
/// convention <c>RealData/BinaryRoundTripGateTests</c> already establishes for this class of defect
/// (a hand-corrupted fixture, not a real-world one), because no real tracked-source corruption
/// naturally exists to lift into <c>TestData</c> the way Track's own seam had (#519's own planning
/// searched for one; none exists — deserializing a source tree is a JSON operation that never
/// touches Mutagen's binary parser at all).
///
/// <para><b>Different exception vocabulary than Track's own seam, confirmed live while planning
/// this ticket.</b> A corrupt <c>FormKey</c> string in a tracked NPC's source JSON does not throw
/// Mutagen's <c>RecordException</c> — it throws
/// <c>Mutagen.Bethesda.Serialization.Exceptions.FilePathedException</c> wrapping a plain
/// <see cref="ArgumentException"/>, whose only identity is the source file path. That shape is
/// pinned at the unit level in <c>Source/PluginDiagnosisTests.FromSourceReadException_AnchorsOnTheFilePathRelativeToTheTree</c>;
/// this test is the end-to-end proof that <see cref="PluginCompileService"/> actually surfaces it
/// through a real tracked mod's own Compile call, not just the extracted diagnosis logic.</para>
/// </summary>
public sealed class PluginCompileServiceDiagnosisTests : IDisposable
{
    private readonly TrackedModFixture _mod = TrackedModFixture.Tracked();

    public void Dispose() => _mod.Dispose();

    [Fact]
    public void Compile_WhenTheTrackedSourceHoldsAMalformedFormKey_NamesTheSourceFileNotJustTheRawExceptionText()
    {
        var npcFile = _mod.NpcSourceFile;
        var original = File.ReadAllText(npcFile);
        File.WriteAllText(npcFile, original.Replace(_mod.Race.ToString(), "NOT-A-FORMKEY", StringComparison.Ordinal));

        var compileService = new PluginCompileService(
            _mod.Mirror, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);
        var result = compileService.Compile(_mod.Plugin, new CompileSource.WorkingTree());

        Assert.False(result.Succeeded);
        Assert.Contains("Npcs", result.RefusalReason);
        Assert.Contains("FixtureNpc", result.RefusalReason);
        Assert.Contains("Malformed FormKey string: NOT-A-FORMKEY", result.RefusalReason);
        Assert.Contains(PluginDiagnosis.UnknownClass, result.RefusalReason);
        Assert.Contains("Re-Track to regenerate the source.", result.RefusalReason);
    }
}
