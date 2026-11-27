using System.Reflection;
using MEditService.Codec.Fallout4;
using MEditService.Codec.Serialization;
using MEditService.Codec.Skyrim;
using MEditService.Codec.Starfield;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Mutagen.Bethesda.Skyrim;
using Mutagen.Bethesda.Starfield;
using Xunit.Abstractions;
using Xunit.Sdk;

namespace MEditService.TestSupport;

/// <summary>The game projects registered before any test runs, as the composition root registers them. A cost paid
/// once per process runs in <see cref="Warm"/> before the first test, so the ceiling judges each test on its own.</summary>
public class GamesRegisteredTestFramework : XunitTestFramework
{
    public GamesRegisteredTestFramework(IMessageSink messageSink) : base(messageSink) =>
        GameCodecs.Register(new Dictionary<GameCategory, IGameCodec>
        {
            [GameCategory.Fallout4] = Fallout4Codec.Instance,
            [GameCategory.Skyrim] = SkyrimCodec.Instance,
            [GameCategory.Starfield] = StarfieldCodec.Instance,
        });

    /// <summary>Mutagen's first write and read of each game's plugin, and the first time the round-trip gate tells two
    /// Fallout 4 plugins apart.</summary>
    protected virtual void Warm()
    {
        using var scratch = new ScratchDirectory("medit-warm-up-");
        var key = ModKey.FromFileName("WarmUp.esp");
        var fallout4 = new Fallout4Mod(key, Fallout4Release.Fallout4);
        fallout4.Npcs.AddNew("WarmUp");
        var written = WriteAndRead(fallout4, scratch, "fallout4", at => Fallout4Mod.CreateFromBinaryOverlay(at, Fallout4Release.Fallout4));
        var skyrim = new SkyrimMod(key, SkyrimRelease.SkyrimSE);
        skyrim.Npcs.AddNew("WarmUp");
        WriteAndRead(skyrim, scratch, "skyrim", at => SkyrimMod.CreateFromBinaryOverlay(at, SkyrimRelease.SkyrimSE));
        var starfield = new StarfieldMod(key, StarfieldRelease.Starfield);
        starfield.Npcs.AddNew("WarmUp");
        WriteAndRead(starfield, scratch, "starfield", at => StarfieldMod.CreateFromBinaryOverlay(at, StarfieldRelease.Starfield));

        fallout4.Npcs.First().EditorID = "WarmUpDiffering";
        var differing = WriteAndRead(fallout4, scratch, "differing", at => Fallout4Mod.CreateFromBinaryOverlay(at, Fallout4Release.Fallout4));
        _ = TestAdapters.Mutagen().DivergenceFrom(
            key.FileName, written, differing, EmptyLoadOrder.Of(GameRelease.Fallout4), HandedStrings.Of(written));
    }

    private static string WriteAndRead(IMod mod, string scratch, string folder, Func<ModPath, IModDisposeGetter> read)
    {
        var at = new ModPath(mod.ModKey, Path.Combine(Directory.CreateDirectory(Path.Combine(scratch, folder)).FullName, mod.ModKey.FileName));
        mod.WriteToBinary(at.Path);
        using var written = read(at);
        _ = written.EnumerateMajorRecords().Count();
        return at.Path;
    }

    protected override ITestFrameworkExecutor CreateExecutor(AssemblyName assemblyName) =>
        new Executor(assemblyName, SourceInformationProvider, DiagnosticMessageSink, Warm);

    // xUnit exits clean on a throw from CreateExecutor and runs no test on one from RunTestCases.
    // A failed warm-up is reported as an error, which fails the run, and the tests still run.
    private sealed class Executor(
        AssemblyName assemblyName, ISourceInformationProvider sourceInformation, IMessageSink diagnostics, Action warm)
        : XunitTestFrameworkExecutor(assemblyName, sourceInformation, diagnostics)
    {
        protected override void RunTestCases(
            IEnumerable<IXunitTestCase> testCases, IMessageSink executionMessageSink, ITestFrameworkExecutionOptions executionOptions)
        {
            try
            {
                warm();
            }
            catch (Exception ex) when (ex is not OutOfMemoryException)
            {
                executionMessageSink.OnMessage(new ErrorMessage(testCases, ex));
            }
            base.RunTestCases(testCases, executionMessageSink, executionOptions);
        }
    }
}
