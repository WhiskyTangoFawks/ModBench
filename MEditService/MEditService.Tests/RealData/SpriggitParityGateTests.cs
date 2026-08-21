using System.Text;
using System.Text.Json.Nodes;
using MEditService.Core.Records;
using MEditService.Core.Schema;
using MEditService.Core.Session;
using MEditService.Core.Source;
using Mutagen.Bethesda;

namespace MEditService.Tests.RealData;

/// <summary>
/// <b>The parity gate: real Spriggit is the compatibility oracle</b> (#455, implementing the teeth of
/// ADR-0041's #444 amendment point 3, "Spriggit is the format specification — never a code
/// dependency").
///
/// <para><b>This gate is the drift-prevention mechanism for the replicated ~80-line convention
/// layer.</b> The amendment walked the dependency ladder and found every code-dependency form
/// structurally unavailable, so Modbench replicates Spriggit's customization and sidecar conventions
/// instead. Replication drifts. What keeps it honest is not review but this: serialize the committed
/// fixture through our own production door and through the real published tool, and diff the two
/// trees against a pinned allowlist of named divergences
/// (<see cref="SpriggitDivergenceAllowlist"/>). Anything outside the allowlist is red.</para>
///
/// <para><b>The allowlist going empty is #444's convergence trigger</b> — the point at which byte
/// parity with the specification is reached and the package-dependency question re-opens as a new
/// issue. Every row is therefore annotated with what would close it.</para>
///
/// <para><b>Non-vacuity is the design constraint, not a nicety.</b> A parity gate that passes because
/// it compared nothing is the classic failure of this exact kind of test, and this one is built so
/// that cannot happen quietly:</para>
/// <list type="bullet">
/// <item>the oracle refuses to return a zero file count (<see cref="SpriggitOracle.Serialize"/>);</item>
/// <item>both sides' file counts, and the size of the path-set symmetric difference, are asserted as
/// numbers rather than implied by an absence of complaints;</item>
/// <item>every allowlist row is asserted by <i>necessity</i> — an <see cref="DivergenceTier.Observed"/>
/// row must be load-bearing for at least one real file, so a divergence that silently disappears
/// upstream turns the gate red rather than green;</item>
/// <item>a byte difference that survives no allowlist row is unexplained <b>even when the two
/// documents parse equal</b>. That last clause is not pedantry: #455 found a real formatting defect
/// on <c>main</c> — <see cref="SpriggitRootHeader.MergeSpriggitSource"/> welding the original first key
/// onto the spliced object's closing brace — which every JSON-level check in the repo was blind to.</item>
/// </list>
///
/// <para><b>Isolation.</b> The oracle is an out-of-process <c>dotnet tool</c> carrying its own Mutagen
/// and Serialization assemblies; see <see cref="SpriggitOracle"/> for why that is the only available
/// mechanism and why the 0.53.1 pin (#385) cannot be reached by it.</para>
///
/// <para><b>Scope.</b> #455 is the parity gate only. The interchange gate (stock Spriggit reconstructs
/// a plugin from our tree; we compile a tree Spriggit wrote) and making CI run this are #465.</para>
/// </summary>
public sealed class SpriggitParityGateTests : IDisposable
{
    private const string Origin = "FixtureMod";

    /// <summary>
    /// Written beside the tree by Track but not by the translation package: real Spriggit writes these
    /// from its CLI/Engine layer, above the per-game package this gate runs. Excluded from the path-set
    /// comparison by name, and the exclusion is itself asserted to remove exactly two files so it can
    /// never quietly grow into a way of hiding a divergence. Their content parity is #465's.
    /// </summary>
    private static readonly string[] CliLevelSidecars = [SpriggitConfigSidecar.FileName, SpriggitMetaSidecar.FileName];

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-parity-").FullName;
    private readonly string _gameDirectory = Directory.CreateTempSubdirectory("medit-parity-game-").FullName;
    private readonly string _oracleTree = Directory.CreateTempSubdirectory("medit-parity-oracle-").FullName;

    public void Dispose()
    {
        TryDelete(_modFolder);
        TryDelete(_gameDirectory);
        TryDelete(_oracleTree);
    }

    private static void TryDelete(string path)
    {
        try { Directory.Delete(path, recursive: true); }
        catch (IOException) { /* best-effort temp cleanup */ }
    }

    [SpriggitOracle.SpriggitFact]
    public async Task OurTree_MatchesRealSpriggits_ExceptForTheAllowlistedDivergences()
    {
        var pluginPath = Path.Combine(_modFolder, CutDownPluginFixture.PluginFileName);
        File.Copy(CutDownPluginFixture.PluginPath, pluginPath);

        var ours = await SerializeThroughOurDoor(pluginPath);
        var oracleFileCount = SpriggitOracle.Serialize(pluginPath, _oracleTree, GameRelease.Fallout4);
        var theirs = ReadTree(_oracleTree);

        // ---- Non-vacuity, before anything is compared -------------------------------------------
        Assert.Equal(theirs.Count, oracleFileCount);
        Assert.True(theirs.Count > 3_000, $"oracle wrote only {theirs.Count} files; expected a full tree.");
        Assert.True(ours.Count > 3_000, $"our door wrote only {ours.Count} files; expected a full tree.");

        // ---- Path-set parity ---------------------------------------------------------------------
        var sidecars = ours.Keys.Where(p => CliLevelSidecars.Contains(Path.GetFileName(p), StringComparer.Ordinal)).ToList();
        Assert.Equal(CliLevelSidecars.Length, sidecars.Count);
        foreach (var sidecar in sidecars) ours.Remove(sidecar);

        var onlyInOurs = ours.Keys.Except(theirs.Keys, StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        var onlyInTheirs = theirs.Keys.Except(ours.Keys, StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        Assert.Equal(Array.Empty<string>(), onlyInOurs);
        Assert.Equal(Array.Empty<string>(), onlyInTheirs);
        Assert.Equal(theirs.Count, ours.Count);

        // ---- No \r on either side, whatever the platform (#451's canonicalization clause, which
        // ---- ADR-0041's #444 amendment left for this gate to adjudicate) -------------------------
        Assert.Equal(0, ours.Values.Count(bytes => bytes.Contains((byte)'\r')));
        Assert.Equal(0, theirs.Values.Count(bytes => bytes.Contains((byte)'\r')));

        // ---- Formatting parity, checked independently of content -----------------------------------
        // The allowlist explains *content* divergences, so a file carrying an allowlisted difference
        // would sail past the classification below no matter how it was formatted — and the root
        // RecordData.json is exactly such a file (DefaultValuedMemberSkipping). That is not
        // hypothetical: #451's SpriggitSource splice welded the original first key onto the spliced
        // object's closing brace, in the one file this gate would otherwise have excused.
        //
        // Both sides write through the same Newtonsoft kernel, so "are these bytes what a plain
        // Formatting.Indented render of this document would produce" is answerable per file, without
        // comparing the two sides and without consulting the allowlist. It is not a property the
        // kernel always has — it renders nested numeric arrays compactly, one row per line, which a
        // plain renderer expands — so the assertion is that <b>both sides deviate in exactly the same
        // places</b>, which is a formatting-parity claim rather than a canonical-form claim, and needs
        // no hardcoded knowledge of where the kernel gets clever. The count is pinned separately so
        // the comparison cannot pass by both sides being trivially empty.
        var oursNonCanonical = NonCanonicallyFormatted(ours);
        var theirsNonCanonical = NonCanonicallyFormatted(theirs);
        Assert.Equal(theirsNonCanonical, oursNonCanonical);
        Assert.Equal(3, oursNonCanonical.Length);

        // ---- Classify every byte-level difference against the allowlist ---------------------------
        var rows = SpriggitDivergenceAllowlist.Rows;
        var necessaryCounts = rows.ToDictionary(row => row.Name, _ => 0, StringComparer.Ordinal);
        var unexplained = new List<string>();
        var identical = 0;
        var differing = 0;

        foreach (var (relativePath, ourBytes) in ours.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            var theirBytes = theirs[relativePath];
            if (ourBytes.AsSpan().SequenceEqual(theirBytes))
            {
                identical++;
                continue;
            }

            differing++;
            var ourNode = JsonNode.Parse(ourBytes);
            var theirNode = JsonNode.Parse(theirBytes);

            if (!NormalizedEqual(ourNode, theirNode, rows))
            {
                unexplained.Add($"{relativePath}: differs beyond every allowlisted divergence");
                continue;
            }

            // A row is necessary here when dropping it alone breaks the explanation. Necessity, not
            // membership, is what makes an Observed row load-bearing.
            var necessary = rows
                .Where(row => !NormalizedEqual(ourNode, theirNode, rows.Where(other => other != row)))
                .ToList();

            if (necessary.Count == 0)
            {
                // Deep-equal as JSON yet different as bytes: a formatting divergence, which no row
                // covers and which is exactly the class of defect that shipped in #451's splice.
                unexplained.Add($"{relativePath}: byte difference with no semantic difference (formatting drift)");
                continue;
            }

            foreach (var row in necessary) necessaryCounts[row.Name]++;
        }

        // ---- The assertions, each quoting what it examined ----------------------------------------
        Assert.Equal(theirs.Count, identical + differing);
        Assert.Equal(Array.Empty<string>(), unexplained.Take(20).ToArray());

        foreach (var row in rows)
        {
            var seen = necessaryCounts[row.Name];
            switch (row.Tier)
            {
                case DivergenceTier.Observed:
                    Assert.True(
                        seen > 0,
                        $"Allowlist row '{row.Name}' explained no file among {differing} differing of "
                        + $"{theirs.Count}. Either it converged upstream — delete the row, and check "
                        + $"whether the allowlist is now empty (#444's convergence trigger) — or the "
                        + $"divergence moved and this gate has stopped watching it. Closes at: {row.ClosesAt}");
                    break;
                case DivergenceTier.DeclaredUnobserved:
                    Assert.True(
                        seen == 0,
                        $"Allowlist row '{row.Name}' is declared unobservable on this fixture but "
                        + $"explained {seen} of {differing} differing files. Upstream changed; "
                        + $"re-tier the row and record why.");
                    break;
                default: throw new InvalidOperationException($"Unhandled tier {row.Tier}.");
            }
        }

        // Pinned totals for the committed fixture — the "what did you actually examine" numbers. Every
        // assertion above is satisfiable by a comparison that enumerated nothing; these are not. They
        // come last so the tier failures above, which explain themselves, are what a reader sees first.
        //
        // The fixture is committed and both trees are deterministic, so these are stable; when one
        // moves, the diff that moved it is the thing to look at rather than the number to update.
        // For scale, the same run before #455 adopted Spriggit's Customizations/Omit set was
        // 2,758 identical / 1,100 differing — omitting Condition.Unknown1 alone closed 981 of those.
        // Row counts exceed the differing total because a Cell or Worldspace document can need two
        // rows at once (an unknown-group-data field *and* a sorted child list).
        Assert.Equal((3_858, 3_739, 119), (theirs.Count, identical, differing));
        Assert.Equal(
            new Dictionary<string, int>(StringComparer.Ordinal)
            {
                ["SortList"] = 118,
                ["OmitUnknownGroupData"] = 3,
                ["OmitUnusedConditionDataFields"] = 0,
                ["DefaultValuedMemberSkipping"] = 1,
            },
            necessaryCounts);

        // ---- #385 canary: the oracle's own Mutagen must not be inflating FO4 ObjectTemplates -------
        // 0.40.1 bundles Mutagen 0.54.0-alpha.78, which predates the aa7cc540e record-type-ordering
        // regression (docs/research/mutagen-objecttemplate-0.54/root-cause.md). That is a property of
        // one version pin, not a guarantee, and an inflated oracle would look like a parity failure in
        // whichever record happened to differ rather than like the toolchain problem it is.
        var ourTemplates = ObjectTemplateCounts(ours);
        Assert.NotEmpty(ourTemplates);
        Assert.Equal(ourTemplates, ObjectTemplateCounts(theirs));
    }

    /// <summary>
    /// Paths whose bytes are not a plain <c>Formatting.Indented</c> render of their own content. On a
    /// correct tree this is not empty — the kernel writes nested numeric arrays (a worldspace cell's
    /// <c>MaxHeightData.HeightMap</c>) compactly, one row per line, and a plain renderer expands them.
    /// Both sides do that identically, so the set is what carries the signal, not its emptiness.
    /// </summary>
    private static string[] NonCanonicallyFormatted(IReadOnlyDictionary<string, byte[]> tree) =>
        [.. tree
            .Where(pair =>
            {
                var text = Encoding.UTF8.GetString(pair.Value);
                return !string.Equals(
                    Newtonsoft.Json.Linq.JToken.Parse(text).ToString(Newtonsoft.Json.Formatting.Indented),
                    text,
                    StringComparison.Ordinal);
            })
            .Select(pair => pair.Key)
            .Order(StringComparer.Ordinal)];

    private static bool NormalizedEqual(JsonNode? ours, JsonNode? theirs, IEnumerable<SpriggitDivergence> rows)
    {
        var materialized = rows.ToList();
        var left = materialized.Aggregate(ours?.DeepClone(), (node, row) => row.Normalize(node));
        var right = materialized.Aggregate(theirs?.DeepClone(), (node, row) => row.Normalize(node));
        return JsonNode.DeepEquals(left, right);
    }

    /// <summary>EditorID → ObjectTemplates count, for every weapon document carrying any.</summary>
    private static SortedDictionary<string, int> ObjectTemplateCounts(IReadOnlyDictionary<string, byte[]> tree)
    {
        var counts = new SortedDictionary<string, int>(StringComparer.Ordinal);
        foreach (var (relativePath, bytes) in tree)
        {
            if (!relativePath.StartsWith("Weapons/", StringComparison.Ordinal)) continue;
            if (JsonNode.Parse(bytes) is not JsonObject document) continue;
            if (document["ObjectTemplates"] is not JsonArray templates) continue;
            counts[document["EditorID"]?.GetValue<string>() ?? relativePath] = templates.Count;
        }
        return counts;
    }

    /// <summary>
    /// Our side, through the production door itself — <see cref="TrackService.SerializeToPristineFiles"/>,
    /// the same call Track makes — rather than a re-implementation in the test. A hand-rolled copy here
    /// would gate a second implementation of the door and prove nothing about the one that ships; that
    /// failure mode already happened once, in <c>ExternalChangeAbsorber</c> (see the door's own comment).
    /// </summary>
    private async Task<Dictionary<string, byte[]>> SerializeThroughOurDoor(string pluginPath)
    {
        using var sessions = new SessionManager(
            new DuckDbRecordIndexFactory(SharedSchemaReflector.Instance, new TableDdlBuilder(SharedSchemaReflector.Instance)));
        ((ISessionManager)sessions).LoadExplicit(
            _gameDirectory,
            [new ExplicitPluginInput(CutDownPluginFixture.PluginFileName, pluginPath, Origin, true)],
            GameRelease.Fallout4);

        var session = sessions.Session!;
        var mod = session.GetMod(CutDownPluginFixture.PluginFileName, Origin)!;
        var pristine = await TrackService.SerializeToPristineFiles(mod, CutDownPluginFixture.PluginFileName, session);

        // Paths come back prefixed with "<plugin>.source/"; strip it so both sides are keyed the same.
        var prefix = $"{CutDownPluginFixture.PluginFileName}{SourceRecordPath.SourceSuffix}{Path.DirectorySeparatorChar}";
        return pristine.ToDictionary(
            file => Relative(file.RelativePath[prefix.Length..]),
            file => file.Content,
            StringComparer.Ordinal);
    }

    private static Dictionary<string, byte[]> ReadTree(string root) =>
        Directory.EnumerateFiles(root, "*", SearchOption.AllDirectories)
            .ToDictionary(
                file => Relative(Path.GetRelativePath(root, file)),
                File.ReadAllBytes,
                StringComparer.Ordinal);

    private static string Relative(string path) => path.Replace(Path.DirectorySeparatorChar, '/');
}
