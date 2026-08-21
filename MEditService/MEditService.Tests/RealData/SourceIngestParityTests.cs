using MEditService.Core.Queries;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;

namespace MEditService.Tests.RealData;

/// <summary>
/// #452 AC3, and the strongest claim in the ticket: <b>a tracked and an untracked copy of the same
/// plugin produce identical extracted rows.</b>
///
/// <para><b>The seam that makes it true is that both paths call the same
/// <see cref="IRecordIndex.Index"/> over the same <c>IModGetter</c> shape</b> — ingest-from-source
/// deserializes the whole tree back into a mod and hands it to the identical method the binary path
/// uses, so there is no second extraction implementation that could drift. This suite checks the
/// construction actually holds rather than trusting the argument, and checks it on
/// <see cref="CutDownPluginFixture"/>: 3,940 authentic records with a populated worldspace, interior
/// and exterior cells, placements, navigation meshes, landscapes, and four VMAD-scripted quests
/// carrying 860 dialogue topics and 2,873 responses. <c>TrackedModFixture</c> — Npc/Race/Keyword only
/// — structurally cannot exercise any of that, which is exactly how #451 shipped a container
/// regression no test could see.</para>
///
/// <para><b>This is also where the round-trip byte-stability premise gets pinned.</b> ADR-0041's #444
/// amendment asserts the whole-mod door "round trips byte-stable"; the document/hash comparison below
/// is what turns that into a checked fact, since <c>records.content_hash</c> is the hash of the
/// codec's canonical serialization and the whole design of <c>SourceIngest.ReconcileHead</c> depends
/// on parse-then-reserialize being an identity.</para>
/// </summary>
public sealed class SourceIngestParityTests : IDisposable
{
    private const string Origin = "FixtureMod";

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-source-parity-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-source-parity-game-").FullName;
    private readonly SessionManager _fromBinary;
    private readonly SessionManager _fromSource;
    private readonly PluginKey _plugin = new(CutDownPluginFixture.PluginFileName, Origin);

    public SourceIngestParityTests()
    {
        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        // Untracked at this point, so this session is the ordinary binary-overlay ingest — the
        // "untracked copy" half of AC3, and the reference every assertion below compares against.
        _fromBinary = NewSession(pluginPath);

        new TrackService(NullLogger<TrackService>.Instance)
            .TrackAsync(_fromBinary.Session!, Origin, SourcePreset.Edits)
            .GetAwaiter().GetResult();

        // Same folder, same plugin file, same origin — the only difference is that it is now tracked,
        // so this session ingests from the source tree Track just wrote.
        _fromSource = NewSession(pluginPath);
    }

    private SessionManager NewSession(string pluginPath)
    {
        var sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)sessions).LoadExplicit(
            _gameDirectory,
            [new ExplicitPluginInput(CutDownPluginFixture.PluginFileName, pluginPath, Origin, true)],
            GameRelease.Fallout4);
        return sessions;
    }

    public void Dispose()
    {
        _fromSource.Dispose();
        _fromBinary.Dispose();
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* scratch, best-effort */ }
        catch (UnauthorizedAccessException) { /* scratch, best-effort */ }
    }

    /// <summary>The load really did read the source tree, not quietly fall back to the binary. Without
    /// this, every parity assertion below would be comparing the binary path against itself and would
    /// pass no matter what ingest-from-source did.</summary>
    [Fact]
    public void TheTrackedSessionReallyIngestedFromSource_NotViaTheBinaryFallback()
    {
        Assert.Empty(_fromSource.Status.Failures);
        Assert.NotNull(SourceIngest.TreeFor(Origin, Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName), CutDownPluginFixture.PluginFileName));
    }

    [Fact]
    public void TheSameRecordsExist_TrackedAndUntracked()
    {
        var binary = AllFormKeys(_fromBinary).ToHashSet(StringComparer.Ordinal);
        var source = AllFormKeys(_fromSource).ToHashSet(StringComparer.Ordinal);

        // The fixture is real data with real containers; an empty or tiny set here would make every
        // other assertion in this file vacuous.
        Assert.True(binary.Count > 2000, $"fixture looks wrong: only {binary.Count} records");
        Assert.Equal(binary.Count, source.Count);
        Assert.Empty(binary.Except(source, StringComparer.Ordinal));
        Assert.Empty(source.Except(binary, StringComparer.Ordinal));
    }

    /// <summary>
    /// AC3's embedded-child requirement, stated as a property of the whole corpus rather than sampled:
    /// every placed reference, navmesh, landscape and <c>Worldspace.TopCell</c> the binary path
    /// extracts as its own record is extracted as its own record from the source tree too — even
    /// though in the source those live <i>inline</i> in their parent's document and have no file of
    /// their own.
    /// </summary>
    [Fact]
    public void EveryEmbeddedChildRecord_IsItsOwnQueryableRecord_OnBothPaths()
    {
        var embeddedTypes = new[] { "refr", "achr", "navm", "land", "cell", "pgre", "pmis", "phzd" };

        foreach (var type in embeddedTypes)
        {
            var binary = CountOf(_fromBinary, type);
            if (binary == 0) continue;

            Assert.Equal(binary, CountOf(_fromSource, type));
        }

        // Positive control: the fixture must really hold embedded children, or the loop above is a
        // walk over an empty set that would pass for a plugin with no containers at all.
        Assert.True(CountOf(_fromBinary, "refr") > 0, "fixture holds no placed references");
        Assert.True(CountOf(_fromBinary, "cell") > 0, "fixture holds no cells");
    }

    /// <summary>
    /// Every FormKey the plugin holds.
    ///
    /// <para>Deliberately not <c>GetNativeFormKeys</c>: that filters to records whose own ModKey is
    /// this plugin, which for a cut-down slice of real game data (almost all of it overrides of
    /// Fallout4.esm) is a single row — an enumeration that would make every comparison here vacuous.</para>
    ///
    /// <para>And deliberately one unpaged query rather than a paging loop: <c>Search</c> orders by
    /// <c>editor_id</c>, which is not unique and is NULL for every placed reference, so successive
    /// LIMIT/OFFSET pages are not a stable partition and a loop over them silently skips and repeats
    /// rows. Caught here by two runs of this same test disagreeing about the binary side's own count.</para>
    /// </summary>
    private List<string> AllFormKeys(SessionManager sessions) =>
        [.. sessions.Index!.Search(new RecordQuery(Plugin: _plugin, Limit: int.MaxValue)).Items.Select(i => i.FormKey)];

    private int CountOf(SessionManager sessions, string recordType) =>
        sessions.Index!.GetRecordTypeCounts(_plugin).FirstOrDefault(c => c.Type == recordType)?.Count ?? 0;

    /// <summary>
    /// The document itself, byte for byte, for every record — AC3's strongest assertion, and also the
    /// check that <b>parse-then-reserialize is an identity</b> for the whole-mod door. That premise
    /// holds: 2,576 of 2,577 documents are byte-identical, so <c>records.content_hash</c> and the git
    /// blob hash of the same record's source file do not diverge.
    ///
    /// <para><b>Allowlisted divergence: exactly one, and it is #369, not this ticket.</b> A single Cell
    /// differs on <c>Lighting.Versioning</c> — the binary <i>overlay</i> reader yields
    /// <c>["Break0","Break1","Break2"]</c> where the <i>deep parser</i> yields <c>["Break0"]</c>. Three
    /// things were checked before concluding that (#452 implementation): the Track-written file on disk
    /// already holds only <c>Break0</c> (no file in the whole tree contains <c>Break2</c>), and the
    /// <i>per-record</i> codec run over a deep parse also yields <c>["Break0"]</c> — identical to the
    /// whole-mod door. So both doors agree, #450's document-shape parity is intact, and what is left is
    /// exactly #369's pinned decompile-vs-parse structural mismatch landing on a Mutagen binary-layout
    /// versioning field.</para>
    ///
    /// <para>It cannot occur in production for a tracked plugin: ingest-from-source does exactly one
    /// parse (ADR-0041's #444 amendment point 2, and #452's scope item 5). This suite is the one place
    /// it can still show, because it deliberately compares an overlay ingest against a deep-parse one.</para>
    ///
    /// <para><b>The divergence is asserted present, not merely tolerated</b> (#455's allowlist design):
    /// if an upstream fix ever makes the two readers agree, this goes red and we find out rather than
    /// carrying a stale exemption. Same for the count and the field.</para>
    /// </summary>
    [Fact]
    public void EveryRecordsDocument_IsByteIdentical_ExceptTheOneKnown369OverlayVsDeepParseCell()
    {
        var mismatched = new List<string>();
        var byType = new Dictionary<string, int>(StringComparer.Ordinal);
        foreach (var formKey in AllFormKeys(_fromBinary))
        {
            var binary = _fromBinary.Index!.GetDocument(formKey, _plugin);
            var source = _fromSource.Index!.GetDocument(formKey, _plugin);
            if (binary?.Body == source?.Body) continue;
            mismatched.Add(formKey);
            var type = binary?.RecordType ?? source?.RecordType ?? "?";
            byType[type] = byType.GetValueOrDefault(type) + 1;
        }

        var byTypeText = string.Join(", ", byType.OrderByDescending(kv => kv.Value).Select(kv => $"{kv.Key}={kv.Value}"));

        // Pinned count and type. The fixture is hermetic and checked in, so any drift here is signal.
        Assert.True(mismatched.Count == 1, $"expected exactly the one known #369 divergence; got {mismatched.Count} ({byTypeText})");
        Assert.Equal("cell=1", byTypeText);

        // ...and pinned to the *field*, so another Cell field starting to diverge cannot hide behind
        // the same count.
        var binaryBody = _fromBinary.Index!.GetDocument(mismatched[0], _plugin)!.Body!;
        var sourceBody = _fromSource.Index!.GetDocument(mismatched[0], _plugin)!.Body!;
        Assert.Contains("\"Break2\"", binaryBody, StringComparison.Ordinal);
        Assert.DoesNotContain("\"Break2\"", sourceBody, StringComparison.Ordinal);
        Assert.Equal(
            StripVersioningBlock(binaryBody),
            StripVersioningBlock(sourceBody));
    }

    /// <summary>Everything except the <c>Versioning</c> array, so the rest of the one allowlisted Cell's
    /// document is still held to byte equality.</summary>
    private static string StripVersioningBlock(string body) =>
        System.Text.RegularExpressions.Regex.Replace(
            body, "\"Versioning\": \\[[^\\]]*\\]", "\"Versioning\": []");

    /// <summary>The extracted spatial tables — the ones derived from a container's <i>structure</i>
    /// rather than from a record's own fields, and therefore the ones most likely to differ if the
    /// source tree reconstituted containment differently from the binary.</summary>
    [Fact]
    public void PlacementAndCellLocationRows_AreIdentical_TrackedAndUntracked()
    {
        var placed = 0;
        var located = 0;

        foreach (var formKey in AllFormKeys(_fromBinary))
        {
            var binaryPlacement = _fromBinary.Index!.GetPlacement(formKey, _plugin);
            var sourcePlacement = _fromSource.Index!.GetPlacement(formKey, _plugin);
            Assert.Equal(binaryPlacement, sourcePlacement);
            if (binaryPlacement != null) placed++;

            var binaryLocation = _fromBinary.Index!.GetCellLocation(_plugin, formKey);
            var sourceLocation = _fromSource.Index!.GetCellLocation(_plugin, formKey);
            Assert.Equal(binaryLocation, sourceLocation);
            if (binaryLocation != null) located++;
        }

        // Positive controls: an all-null comparison is trivially equal on both sides.
        Assert.True(placed > 0, "fixture produced no placement rows");
        Assert.True(located > 0, "fixture produced no cell_location rows");
    }

    /// <summary>
    /// <c>form_lookup</c> and <c>form_references</c>, through the two reads that answer from them —
    /// FormKey resolution and the reference graph. Both are pure derivations of the documents above,
    /// so this is the check that the derivation ran identically, not just that the documents matched.
    /// </summary>
    [Fact]
    public void FormLookupAndReferenceRows_AreIdentical_TrackedAndUntracked()
    {
        var referenced = 0;
        var indexOnly = 0;
        var setDiff = 0;

        foreach (var formKey in AllFormKeys(_fromBinary))
        {
            Assert.Equal(_fromBinary.Index!.Resolve(formKey), _fromSource.Index!.Resolve(formKey));

            var binaryRefs = _fromBinary.Index!.GetReferencedBy(formKey).OrderBy(r => r.ToString(), StringComparer.Ordinal).ToList();
            var sourceRefs = _fromSource.Index!.GetReferencedBy(formKey).OrderBy(r => r.ToString(), StringComparer.Ordinal).ToList();
            referenced += binaryRefs.Count;
            if (binaryRefs.SequenceEqual(sourceRefs)) continue;

            static List<string> Deindexed(IEnumerable<ReferenceResult> rs) =>
                rs.Select(r => System.Text.RegularExpressions.Regex.Replace(r.ToString() ?? "", @"\[\d+\]", "[i]"))
                  .OrderBy(x => x, StringComparer.Ordinal).ToList();
            if (Deindexed(binaryRefs).SequenceEqual(Deindexed(sourceRefs), StringComparer.Ordinal)) indexOnly++; else setDiff++;
        }

        Assert.True(referenced > 0, "fixture produced no form_references rows");

        // Hard: no reference may appear or disappear. Only the array *ordinal* inside a FieldPath is
        // allowlisted, and only for the folder-split-ordering reason documented on the sibling test.
        Assert.True(setDiff == 0, $"form_references differs by SET for {setDiff} target(s) — not allowlisted");

        // Asserted present, not tolerated: pinned at 319 targets (of 6,280 rows) against the hermetic
        // fixture, so an upstream change in either direction is signal.
        Assert.Equal(319, indexOnly);
    }

    /// <summary>
    /// <c>container_child</c>, the slot table #416 added for the containment relationships placement
    /// and cell_location do not already carry — Quest's dialogue branches and topics, and DialogTopic's
    /// responses, which stay folder-split in the source tree rather than embedded.
    ///
    /// <para><b>Allowlisted divergence: slot ORDER, never the containment set.</b> The graph is
    /// identical — every parent holds exactly the same children in both ingests — but their
    /// <c>SlotIndex</c> values differ for 233 parents. <b>Spriggit's layout carries no child ordering
    /// at all.</b> Traced in <c>references/mutagen-serialization</c> (#452 implementation): the reader
    /// does <c>Directory.GetFiles(...).OrderBy(TryGetNumber(...))</c>, and <c>TryGetNumber</c> returns
    /// null unless the file name starts with a <c>"[N] "</c> prefix — which is written only under
    /// <c>Overall.EnforceRecordOrder</c>, off in this project and in Spriggit alike (zero call sites).
    /// <c>OrderBy</c> on an all-null key is a stable sort, so what survives is filesystem order, not
    /// the binary's GRUP order.</para>
    ///
    /// <para>Turning <c>EnforceRecordOrder</c> on would fix it and was <b>rejected</b>: it puts
    /// <c>"[N] "</c> into on-disk file names, abandoning the layout ADR-0041 pins wholesale and the
    /// Spriggit byte-parity convergence target #455 gates. Order is therefore <i>stable</i> (same tree,
    /// same order) without being <i>canonical</i> against the pre-Track binary — which is what #454's
    /// scope item 4 already says a compiled-from-text binary does, and what
    /// <see cref="CompileRoundTripGateTests"/>' own doc comment concedes for container grouping.</para>
    /// </summary>
    [Fact]
    public void ContainerChildRows_AreIdentical_ExceptSlotOrderWhichSpriggitsLayoutDoesNotCarry()
    {
        var children = 0;
        var orderOnly = 0;
        var setDiff = 0;

        foreach (var formKey in AllFormKeys(_fromBinary))
        {
            var binary = _fromBinary.Index!.GetContainerChildren(_plugin, formKey);
            var source = _fromSource.Index!.GetContainerChildren(_plugin, formKey);
            children += binary.Count;
            if (binary.SequenceEqual(source)) continue;

            var bset = binary.Select(r => $"{r.ParentFormKey}|{r.SlotName}|{r.ChildFormKey}").OrderBy(x => x, StringComparer.Ordinal).ToList();
            var sset = source.Select(r => $"{r.ParentFormKey}|{r.SlotName}|{r.ChildFormKey}").OrderBy(x => x, StringComparer.Ordinal).ToList();
            if (bset.SequenceEqual(sset, StringComparer.Ordinal)) orderOnly++; else setDiff++;
        }

        Assert.True(children > 0, "fixture produced no container_child rows");

        // Hard: the containment graph itself may not move. A child appearing under a different parent,
        // or vanishing, is red — only the ordinal within a slot is allowlisted.
        Assert.True(setDiff == 0, $"container_child differs by SET for {setDiff} parent(s) — not allowlisted");

        // Asserted present, not tolerated: pinned at 233 parents (of 3,816 rows) against the hermetic
        // fixture. If upstream ever starts preserving folder-split order, this goes red and we learn it.
        Assert.Equal(233, orderOnly);
    }
}
