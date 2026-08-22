using System.Text.Json;
using MEditService.Core.Edits;
using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Serialization;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;
using Noggog.WorkEngine;

namespace MEditService.Tests.RealData;

/// <summary>
/// #416's own permanent gate on the compiled output — the pinned contract's "the round-trip
/// stability gate covers the compiled output" — run against the real, curated #369 fixture
/// (<see cref="CutDownPluginFixture"/>: 3,940 authentic records, populated worldspace/cell/placement,
/// four VMAD-scripted quests carrying 860 dialogue topics and 2,873 responses between them,
/// navigation meshes, landscapes).
///
/// <b>What "round trip" means for compile, and why it isn't <see cref="BinaryRoundTripGateTests"/>'s
/// original-vs-write1 shape</b>: compile's whole premise (ADR-0041) is that it builds a binary from
/// source text alone, never from an existing binary's own structure — there is no "original binary"
/// in that flow to byte-match, and container grouping details a game engine doesn't read (which
/// bucket an interior cell's GRUP sits in) have no canonical "correct" value to reproduce, only a
/// stable one. What compile promises instead, and what these tests measure:
/// <list type="bullet">
/// <item><b>Content fidelity</b>: every record's source text, deep-parsed back out of the compiled
/// binary through the exact same codec Track uses, is byte-identical to the source text Track itself
/// wrote before compile ever ran. A record's *content* survived the round trip even where its
/// container's internal bucketing did not.</item>
/// <item><b>Determinism</b> (<see cref="BinaryRoundTripGateTests"/>'s write1==write2 shape, applied
/// to this path): compiling the same source tree twice produces byte-identical binaries.</item>
/// </list>
/// </summary>
public sealed class CompileRoundTripGateTests : IDisposable
{
    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-compile-roundtrip-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-compile-roundtrip-game-").FullName;
    private readonly SessionManager _sessions;
    private readonly PluginKey _plugin = new(CutDownPluginFixture.PluginFileName, "FixtureMod");

    public CompileRoundTripGateTests()
    {
        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        _sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)_sessions).LoadExplicit(
            _gameDirectory,
            [new ExplicitPluginInput(CutDownPluginFixture.PluginFileName, pluginPath, _plugin.Origin!, true)],
            GameRelease.Fallout4);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_sessions.Session!, _plugin.Origin!, SourcePreset.Edits)
            .GetAwaiter().GetResult();
    }

    public void Dispose()
    {
        _sessions.Dispose();
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }

    private PluginCompileService CompileService() =>
        new(_sessions, new PluginWriter(NullLogger<PluginWriter>.Instance), NullLogger<PluginCompileService>.Instance);

    private string SourceRoot => Path.Combine(_modFolder, $"{CutDownPluginFixture.PluginFileName}{SourceRecordPath.SourceSuffix}");

    /// <summary>The tree Track wrote, keyed exactly the way <see cref="DeriveSourceTreeFromBinary"/>
    /// keys its own, so the two dictionaries are directly comparable.</summary>
    private Dictionary<string, byte[]> ReadSourceTree() =>
        Directory.EnumerateFiles(SourceRoot, "*.json", SearchOption.AllDirectories)
            .ToDictionary(f => Path.GetRelativePath(_modFolder, f), File.ReadAllBytes);

    /// <summary>
    /// Deep-parses <paramref name="pluginPath"/> and re-derives the source tree it would produce,
    /// through the same whole-mod door Track itself writes through.
    ///
    /// <para><b>#454: whole-mod, not per-record.</b> This used to rebuild the tree one record at a time
    /// through <c>SourceRecordPath.For</c> — the pre-#451 Track model, which covers flat records only
    /// and throws for the Cells/Worldspaces/Quests this fixture is full of. Reconstructing their
    /// directory nesting by hand here would mean owning a second copy of the serializer's own layout
    /// policy; calling the serializer is both shorter and the only version that cannot drift from what
    /// Track wrote. Tests may call the door — the whitelist scan in
    /// <c>RecordTextCodecGeneratorSeedTests</c> is scoped to <c>MEditService.Core</c> sources.</para>
    ///
    /// <para>One post-step makes the derived tree comparable rather than merely similar, and it is
    /// Track's own (<c>TrackService.TrackAsync</c>): the <c>\r</c> strip. Everything in the tree, the
    /// mod header's own root document included, is inside the comparison — Track writes no sidecar
    /// beside it (#468, ADR-0042: "Spriggit has no role in v1"), so there is nothing left to
    /// exclude.</para>
    /// </summary>
    private static Dictionary<string, byte[]> DeriveSourceTreeFromBinary(string pluginPath, GameRelease release)
    {
        var pluginFileName = Path.GetFileName(pluginPath);
        var mod = ModFactory.ImportSetter(new ModPath(ModKey.FromFileName(pluginFileName), pluginPath), release);

        var scratch = Directory.CreateTempSubdirectory("medit-compile-derived-").FullName;
        try
        {
            RecordTextCodecGeneratorSeed
                .SerializeWholeMod((IFallout4ModGetter)mod, scratch, InlineWorkDropoff.Instance, CancellationToken.None)
                .GetAwaiter().GetResult();

            return Directory.EnumerateFiles(scratch, "*.json", SearchOption.AllDirectories)
                .ToDictionary(
                    f => Path.Combine(
                        $"{pluginFileName}{SourceRecordPath.SourceSuffix}", Path.GetRelativePath(scratch, f)),
                    f => StripCarriageReturns(File.ReadAllBytes(f)));
        }
        finally
        {
            TryDelete(scratch);
        }
    }

    // TrackService's own canonicalization at the door, mirrored here so the derived tree is compared
    // against the tracked one on equal terms rather than differing by line endings on Windows.
    private static byte[] StripCarriageReturns(byte[] bytes) => [.. bytes.Where(b => b != (byte)'\r')];

    // #451 review, finding 5 (AC1 gap): the spike doc's own layout sketch names Cells/<block>/
    // <subblock>/... and Worldspaces/<ws>/<X, Y>/<X, Y>/... nesting, and nothing anywhere asserted
    // either exists after a real Track — even though this class's own constructor Tracks exactly the
    // one fixture with real populated cells/worldspaces (mEditTestSubset.esm) this suite has.
    // TrackServiceTests' own fixture is flat-only (two NPCs) and structurally cannot exercise this.
    // Key paths only, per AC1's own wording, via pattern match rather than a hardcoded block/
    // sub-block number this test has no independent way to verify without reading the fixture's own
    // binary data by hand.
    [Fact]
    public void Track_OfTheRealFixture_WritesTheSpriggitContainerLayout()
    {
        var allFiles = Directory.EnumerateFiles(SourceRoot, "*", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(SourceRoot, f).Replace('\\', '/'))
            .ToList();
        Assert.NotEmpty(allFiles);

        Assert.Contains(allFiles, f => System.Text.RegularExpressions.Regex.IsMatch(
            f, @"^Cells/-?\d+/-?\d+/[^/]+/RecordData\.json$"));

        Assert.Contains(allFiles, f => System.Text.RegularExpressions.Regex.IsMatch(
            f, @"^Worldspaces/[^/]+/-?\d+, -?\d+/-?\d+, -?\d+/[^/]+/RecordData\.json$"));
    }

    /// <summary>#468: Tracking the committed fixture writes a root document with no Spriggit package
    /// stamp and no sidecar beside the tree (ADR-0042, "Spriggit has no role in v1") — checked against
    /// the real, curated #369 fixture this whole class Tracks in its constructor, not a synthetic
    /// stand-in.</summary>
    [Fact]
    public void Track_OfTheRealFixture_WritesNoSpriggitStampOrSidecar()
    {
        var allFiles = Directory.EnumerateFiles(SourceRoot, "*", SearchOption.AllDirectories)
            .Select(f => Path.GetRelativePath(SourceRoot, f).Replace('\\', '/'))
            .ToList();
        Assert.NotEmpty(allFiles);

        Assert.DoesNotContain(".spriggit", allFiles);
        Assert.DoesNotContain("spriggit-meta.json", allFiles);

        var rootText = File.ReadAllText(Path.Combine(SourceRoot, "RecordData.json"));
        Assert.DoesNotContain("SpriggitSource", rootText, StringComparison.Ordinal);
    }

    [Fact]
    public void Compile_OfTheRealFixture_Succeeds()
    {
        var result = CompileService().Compile(_plugin, new CompileSource.WorkingTree());

        Assert.True(result.Succeeded, result.RefusalReason);
    }

    [Fact]
    public void Compile_OfTheRealFixture_PreservesEveryRecordsSourceContent()
    {
        var before = ReadSourceTree();
        Assert.NotEmpty(before);

        var result = CompileService().Compile(_plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);
        var after = DeriveSourceTreeFromBinary(pluginPath, GameRelease.Fallout4);

        Assert.Equal(before.Count, after.Count);
        foreach (var (relativePath, beforeBytes) in before)
        {
            Assert.True(after.TryGetValue(relativePath, out var afterBytes),
                $"{relativePath} exists before compile but not after.");
            Assert.True(beforeBytes.AsSpan().SequenceEqual(afterBytes),
                $"{relativePath}'s content changed across compile.");
        }
    }

    [Fact]
    public void Compile_OfTheRealFixture_IsDeterministic()
    {
        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);

        var result1 = CompileService().Compile(_plugin, new CompileSource.WorkingTree());
        Assert.True(result1.Succeeded, result1.RefusalReason);
        var write1 = File.ReadAllBytes(pluginPath);

        var result2 = CompileService().Compile(_plugin, new CompileSource.WorkingTree());
        Assert.True(result2.Succeeded, result2.RefusalReason);
        var write2 = File.ReadAllBytes(pluginPath);

        Assert.True(write1.AsSpan().SequenceEqual(write2),
            $"Compile is not byte-stable across repeated runs: write1 {write1.Length:N0} B vs write2 {write2.Length:N0} B.");
    }

    /// <summary>
    /// #454 AC1, as a byte-level statement over the whole tree: Track → edit one field → Save &amp;
    /// Compile, and the tree re-derived from the compiled binary differs from the pre-edit tree in
    /// <b>exactly one file</b> — the edited record's own.
    ///
    /// <para>This is the text-stability criterion promoted to a compile gate, and it is deliberately
    /// stated as a set equality rather than as "the edited file changed". "The edit landed" is already
    /// covered (<c>PluginCompileServiceTests</c>); what only this can catch is the edit landing
    /// <i>and</i> something else moving with it — a container's children reordered, a header rewritten,
    /// a record dropped — across all ~2,600 files of the real #369 fixture. Every one of those would be
    /// a silent content change in the user's plugin, and every one of them shows up here as a second
    /// entry in <c>changed</c>.</para>
    ///
    /// <para>A flat NPC is the subject on purpose: its source unit is one file, so "exactly one file"
    /// has an unambiguous expected value. An embedded child's edit would legitimately change its
    /// <i>parent's</i> file, which is a different (and weaker) assertion.</para>
    /// </summary>
    [Fact]
    public void Compile_AfterOneFieldEdit_ChangesExactlyThatRecordsFileInTheReserializedTree()
    {
        var npc = _sessions.Index!
            .Search(new RecordQuery(RecordTypes: ["npc_"], Plugin: _plugin, Limit: 1))
            .Items[0];
        var expectedPath = SourceRecordPath.For(
            CutDownPluginFixture.PluginFileName, "npc_", npc.FormKey, npc.EditorId, GameRelease.Fallout4);

        var before = ReadSourceTree();
        Assert.Contains(expectedPath, before.Keys);

        var edit = new RecordEditService(_sessions, SharedSchemaReflector.Instance, NullLogger<RecordEditService>.Instance)
            .EditField(_plugin, npc.FormKey, "height_max", JsonDocument.Parse("0.75").RootElement);
        Assert.True(edit.Applied, edit.Message);

        var result = CompileService().Compile(_plugin, new CompileSource.WorkingTree());
        Assert.True(result.Succeeded, result.RefusalReason);

        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);
        var after = DeriveSourceTreeFromBinary(pluginPath, GameRelease.Fallout4);

        Assert.Equal(before.Keys.Order(), after.Keys.Order());
        var changed = before
            .Where(kv => !kv.Value.AsSpan().SequenceEqual(after[kv.Key]))
            .Select(kv => kv.Key)
            .Order()
            .ToList();

        Assert.Equal([expectedPath], changed);
    }
}
