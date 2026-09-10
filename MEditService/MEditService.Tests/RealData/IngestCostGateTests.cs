using System.Diagnostics;
using MEditService.Core.Plugins;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Installs;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Xunit.Abstractions;

namespace MEditService.Tests.RealData;

/// <summary>The codec's cost against today's binary-path first index. If this ceiling ever fails,
/// the fix is the codec's speed, never a second reader.</summary>
public sealed class IngestCostGateTests(ITestOutputHelper output)
{
    // Repeated runs here: binary first-index 380-2030 ms, codec-only path 180-1490 ms. This
    // ceiling sits above the highest binary number seen, so a second gate run sharing the machine
    // cannot flake it.
    private const long CodecPathCeilingMs = 5000;

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
        var codecPathMs = Time(() => RunCodecPath(schemas, codec, modPath));

        output.WriteLine(
            $"binary first-index (this run): {binaryFirstIndexMs} ms; codec path (this run): {codecPathMs} ms; ceiling: {CodecPathCeilingMs} ms");

        Assert.True(codecPathMs < CodecPathCeilingMs,
            $"Codec path took {codecPathMs} ms against a ceiling of {CodecPathCeilingMs} ms " +
            $"(this run's binary first-index: {binaryFirstIndexMs} ms).");
    }

    // Quotes the codec path's cost beside a fresh instance's binary first index, both over this
    // machine's full vanilla masters. Never gated: no committed fixture backs a fixed ceiling here.
    [SmokeFact]
    public void FullVanillaMasters_QuotesBinaryAndCodecTimeUngated()
    {
        var locator = new GameLocator();
        if (!locator.TryGetDataDirectory(GameRelease.Fallout4, out var dataDir))
        {
            output.WriteLine("MEDIT_SMOKE=1 was set but no Fallout4 install was discovered on this machine; nothing to quote.");
            return;
        }

        var masterNames = HeldPlugins.ForcedNames(dataDir.Path, GameRelease.Fallout4);
        Assert.NotEmpty(masterNames);

        var reflector = SharedSchemaReflector.Instance;
        var ddl = new TableDdlBuilder(reflector);
        var schemas = reflector.GetSchemas(GameRelease.Fallout4);
        var codec = new RecordTextCodec(NullLogger<RecordTextCodec>.Instance);

        var codecMs = 0L;
        var codecRecords = 0;
        foreach (var name in masterNames)
        {
            var path = Path.Combine(dataDir.Path, name);
            using var overlay = ModFactory.ImportGetter(
                new ModPath(ModKey.FromFileName(name), path), GameRelease.Fallout4,
                LocalizedStrings.ForRead(modFolder: null, dataDir.Path));
            var sw = Stopwatch.StartNew();
            var records = SerializeEveryRecord(schemas, codec, overlay);
            sw.Stop();
            codecMs += sw.ElapsedMilliseconds;
            codecRecords += records;
        }

        var binaryMs = Time(() => RunBinaryFirstIndexOverMasters(reflector, ddl, dataDir.Path, masterNames));

        output.WriteLine(
            $"binary first-index over {masterNames.Count} full vanilla master(s): {binaryMs} ms; " +
            $"codec path over the same masters, {codecRecords} records: {codecMs} ms (both ungated).");
    }

    // One fresh DuckDB index, every master indexed into it in load-order slots.
    private static void RunBinaryFirstIndexOverMasters(
        SchemaReflector reflector, TableDdlBuilder ddl, string dataFolderPath, IReadOnlyList<string> masterNames)
    {
        using var repo = new DuckDbRecordIndex(reflector, ddl, NullLogger.Instance);
        repo.Initialize(GameRelease.Fallout4);
        for (var slot = 0; slot < masterNames.Count; slot++)
        {
            var name = masterNames[slot];
            var path = Path.Combine(dataFolderPath, name);
            using var overlay = ModFactory.ImportGetter(
                new ModPath(ModKey.FromFileName(name), path), GameRelease.Fallout4,
                LocalizedStrings.ForRead(modFolder: null, dataFolderPath));
            repo.Index(overlay, Registration.Participating(slot), new PluginKey(name, "Data"));
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
        repo.Index(overlay, Registration.Participating(0), new PluginKey(overlay.ModKey.FileName.ToString(), "Data"));
    }

    // Open through the importer, enumerate every major record, serialise each through
    // RecordTextCodec — what PluginIngest.PrepareRecord does per record today — touching nothing
    // in DuckDB.
    private static void RunCodecPath(IReadOnlyDictionary<string, RecordTableSchema> schemas, RecordTextCodec codec, ModPath modPath)
    {
        using var overlay = ModFactory.ImportGetter(modPath, GameRelease.Fallout4);
        SerializeEveryRecord(schemas, codec, overlay);
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

    // Skipped, not passed, without MEDIT_SMOKE=1 — the same shape as
    // RealInstallSmokeTests.SmokeFactAttribute, duplicated: no other coupling between the two.
    private sealed class SmokeFactAttribute : FactAttribute
    {
        public SmokeFactAttribute()
        {
            if (Environment.GetEnvironmentVariable("MEDIT_SMOKE") != "1")
                Skip = "Set MEDIT_SMOKE=1 to run the vanilla-masters codec cost smoke test.";
        }
    }
}
