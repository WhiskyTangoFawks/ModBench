using System.Diagnostics;
using MEditService.Http;
using MEditService.PluginAdapter;
using MEditService.LoadOrder;
using MEditService.Index;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.SourceRepo;
using MEditService.Tests.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog;
using Xunit.Abstractions;

namespace MEditService.Tests.RealData;

/// <summary>The codec's cost against today's binary-path first index. If this ceiling ever fails,
/// the fix is the codec's speed, never a second reader.</summary>
public sealed class IngestCostGateTests(ITestOutputHelper output)
{
    // Repeated runs here: binary first-index 380-2326 ms, codec-only path 180-1490 ms. This
    // ceiling sits above the highest binary number seen, so a second gate run sharing the machine
    // cannot flake it.
    private const long CodecPathCeilingMs = 5000;

    // Which candidates are usable is decided here, the same list RealInstallSmokeTests offers.
    private static readonly GameRelease[] CandidateGames =
    [
        GameRelease.Fallout4,
        GameRelease.SkyrimSE,
        GameRelease.Starfield,
    ];

    [Fact]
    public void CodecPath_OnCutDownFixture_StaysUnderCeilingSetFromBinaryFirstIndex()
    {
        var reflector = SharedSchemaReflector.Instance;
        var ddl = new TableDdlBuilder(reflector);
        var schemas = reflector.GetSchemas(GameRelease.Fallout4);
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);
        var modPath = new ModPath(
            ModKey.FromFileName(CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginPath);

        // Unmeasured: settles JIT and reflection caches before either timed pass below.
        RunBinaryFirstIndex(reflector, ddl, modPath);
        RunCodecPath(schemas, codec, modPath);

        var binaryFirstIndexMs = Time(() => RunBinaryFirstIndex(reflector, ddl, modPath));
        var codecRecords = 0;
        var codecPathMs = Time(() => codecRecords = RunCodecPath(schemas, codec, modPath));

        output.WriteLine(
            $"binary first-index (this run): {binaryFirstIndexMs} ms; codec path (this run): {codecPathMs} ms " +
            $"over {codecRecords} records; ceiling: {CodecPathCeilingMs} ms");

        // A schema/table set that resolved to zero records would make the codec pass trivially
        // fast without measuring anything the ceiling below is supposed to bound.
        Assert.True(codecRecords > 0, "Codec path serialized 0 records — the gate would measure nothing.");

        Assert.True(codecPathMs < CodecPathCeilingMs,
            $"Codec path took {codecPathMs} ms over {codecRecords} records against a ceiling of {CodecPathCeilingMs} ms " +
            $"(this run's binary first-index: {binaryFirstIndexMs} ms).");
    }

    // Quotes the codec path's cost beside a fresh instance's binary first index, both over this
    // machine's full vanilla masters. Never gated: no committed fixture backs a fixed ceiling here.
    [SmokeFact("run the vanilla-masters codec cost smoke test")]
    public void FullVanillaMasters_QuotesBinaryAndCodecTimeUngated()
    {
        var locator = new GameLocator();
        var reflector = SharedSchemaReflector.Instance;

        (GameRelease Release, DirectoryPath DataDir)? discovered = null;
        foreach (var release in CandidateGames)
        {
            if (!reflector.IsSupported(release)) continue;
            if (!locator.TryGetDataDirectory(release, out var candidateDataDir)) continue;
            discovered = (release, candidateDataDir);
            break;
        }

        Assert.True(discovered is not null,
            "MEDIT_SMOKE=1 was set but no supported game install was discovered to smoke-test.");
        var (gameRelease, dataDir) = discovered!.Value;

        var masterNames = ForcedPlugins.Names(dataDir.Path, gameRelease);
        Assert.NotEmpty(masterNames);

        var ddl = new TableDdlBuilder(reflector);
        var schemas = reflector.GetSchemas(gameRelease);
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);

        // Timed from the same starting line as the binary pass below: both include the importer's
        // open, so the two numbers are comparable rather than one crediting the codec with a head
        // start.
        var codecMs = 0L;
        var codecRecords = 0;
        foreach (var name in masterNames)
        {
            var path = Path.Combine(dataDir.Path, name);
            var sw = Stopwatch.StartNew();
            using var overlay = ModFactory.ImportGetter(
                new ModPath(ModKey.FromFileName(name), path), gameRelease,
                LocalizedStrings.ForRead(new PluginStrings(null, dataDir.Path)));
            var records = SerializeEveryRecord(schemas, codec, overlay);
            sw.Stop();
            codecMs += sw.ElapsedMilliseconds;
            codecRecords += records;
        }

        var binaryMs = Time(() => RunBinaryFirstIndexOverMasters(reflector, ddl, gameRelease, dataDir.Path, masterNames));

        output.WriteLine(
            $"binary first-index over {masterNames.Count} full vanilla master(s) ({gameRelease}): {binaryMs} ms; " +
            $"codec path (open + serialize) over the same masters, {codecRecords} records: {codecMs} ms (both ungated).");
    }

    // One fresh DuckDB index, every master indexed into it in load-order slots.
    private static void RunBinaryFirstIndexOverMasters(
        SchemaReflector reflector, TableDdlBuilder ddl, GameRelease gameRelease, string dataFolderPath,
        IReadOnlyList<string> masterNames)
    {
        using var repo = new DuckDbRecordIndex(reflector, ddl, NullLogger.Instance);
        repo.Initialize(gameRelease);
        for (var slot = 0; slot < masterNames.Count; slot++)
        {
            var name = masterNames[slot];
            var path = Path.Combine(dataFolderPath, name);
            using var overlay = ModFactory.ImportGetter(
                new ModPath(ModKey.FromFileName(name), path), gameRelease,
                LocalizedStrings.ForRead(new PluginStrings(null, dataFolderPath)));
            repo.IndexMod(overlay, Registration.Participating(slot), new PluginKey(name, "Data"));
        }
    }

    private static long Time(Action action)
    {
        var sw = Stopwatch.StartNew();
        action();
        sw.Stop();
        return sw.ElapsedMilliseconds;
    }

    // The existing projector path, the shape the cut-down plugin index tests already use: a fresh
    // DuckDB index, one Index() call.
    private static void RunBinaryFirstIndex(SchemaReflector reflector, TableDdlBuilder ddl, ModPath modPath)
    {
        using var overlay = ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        using var repo = new DuckDbRecordIndex(reflector, ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        repo.IndexMod(overlay, Registration.Participating(0), new PluginKey(overlay.ModKey.FileName.ToString(), "Data"));
    }

    // Open through the importer, enumerate every major record, serialise each through
    // RecordTextCodec. Returns the record count so a caller can tell a real pass from an empty one.
    private static int RunCodecPath(IReadOnlyDictionary<string, RecordTableSchema> schemas, RecordTextCodec codec, ModPath modPath)
    {
        using var overlay = ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        return SerializeEveryRecord(schemas, codec, overlay);
    }

    private static int SerializeEveryRecord(IReadOnlyDictionary<string, RecordTableSchema> schemas, RecordTextCodec codec, IModGetter mod)
    {
        var count = 0;
        foreach (var (tableName, schema) in schemas)
        {
            if (tableName == PluginHeader.RecordType) continue;
            foreach (var record in mod.EnumerateMajorRecords(schema.RecordType, throwIfUnknown: false))
            {
                codec.SerializeToBytesAsync(record, mod.GameRelease).GetAwaiter().GetResult();
                count++;
            }
        }
        return count;
    }
}
