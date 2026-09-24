using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.SourceAdapter;
using MEditService.SourceAdapter.Tests.TestSupport;
using MEditService.TestSupport;
using Microsoft.Extensions.Logging.Abstractions;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.SourceAdapter.Tests.Source;

/// <summary>Replaying the edit branch onto a baseline another tool moved: refused over uncommitted
/// dirt, clean when nothing overlaps, conflicted when the same document changed on both sides, and
/// resumable by the same verb (ADR-0007).</summary>
public sealed class SourceRepositoryRebaseTests : IDisposable
{
    private const string PluginName = "Rebase.esp";
    private const string NpcEditorId = "FixtureNpc";
    private const float BaselineHeightMax = 0.5f;

    private static readonly PluginCopyKey Plugin = new(PluginName, "RebaseMod");
    private static readonly GameRelease Release = GameRelease.Fallout4;

    private readonly string _modFolder = Directory.CreateTempSubdirectory("medit-rebase-").FullName;
    private readonly RecordTextCodec _codec = new(NullLogger<RecordTextCodec>.Instance);

    private readonly string _npcRelativePath;
    private readonly string _npcFormKey;

    // The baseline tree, committed to main and checked out on the edit branch, is the one the
    // product's own Track makes.
    public SourceRepositoryRebaseTests()
    {
        var mod = Upstream(BaselineHeightMax, withNewRecord: false);
        var npc = mod.Npcs.Single(n => n.EditorID == NpcEditorId);
        _npcFormKey = npc.FormKey.ToString();
        _npcRelativePath = NpcPathOf(npc);
        PluginBaselines.Track(
            _modFolder, SourcePreset.Edits, TreeOf(mod));
    }

    public void Dispose()
    {
        try { Directory.Delete(_modFolder, recursive: true); }
        catch (IOException) { /* scratch directory, best effort */ }
    }

    private string Git(params string[] args) =>
        GitProbe.Run(Path.Combine(_modFolder, ".git"), _modFolder, args);

    private SourceRepository Repository =>
        SourceRepository.Open(_modFolder, Release)
            ?? throw new InvalidOperationException($"Expected '{_modFolder}' to already be tracked.");

    private string NpcFullPath => Path.Combine(_modFolder, _npcRelativePath);

    // The same records in the same order every time, so each rebuild allocates the same FormKeys and
    // the tree paths line up between the baseline and what upstream committed over it.
    private static Fallout4Mod Upstream(float heightMax, bool withNewRecord)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(PluginName), Fallout4Release.Fallout4);
        var race = mod.Races.AddNew("FixtureRace");
        var npc = mod.Npcs.AddNew(NpcEditorId);
        npc.Race.SetTo(race);
        npc.HeightMax = heightMax;
        mod.Npcs.AddNew("UntouchedNpc");
        if (withNewRecord) mod.Npcs.AddNew("BrandNewUpstreamNpc");
        return mod;
    }

    private static string NpcPathOf(INpcGetter npc) =>
        Path.Combine(
            SourceRepository.RootFor(PluginName), "Npcs",
            $"{npc.EditorID} - {npc.FormKey.ID:X6}_{npc.FormKey.ModKey.FileName}.json");

    private static string RacePathOf(IRaceGetter race) =>
        Path.Combine(
            SourceRepository.RootFor(PluginName), "Races",
            $"{race.EditorID} - {race.FormKey.ID:X6}_{race.FormKey.ModKey.FileName}.json");

    private TreeFile[] TreeOf(IFallout4ModGetter mod) =>
    [
        new(SourceRepository.HeaderDocumentFor(PluginName), HeaderDocument.Write(mod)),
        .. mod.Races.Select(race => new TreeFile(RacePathOf(race), Serialize(race))),
        .. mod.Npcs.Select(npc => new TreeFile(NpcPathOf(npc), Serialize(npc))),
    ];

    private byte[] Serialize(IMajorRecordGetter record) =>
        _codec.SerializeToBytes(record, Release);

    // My own edit, made the way a write makes it: the record's document replaced through the
    // repository, leaving the working tree dirty on the edit branch.
    private void EditHeightMax(float heightMax)
    {
        var body = File.ReadAllText(NpcFullPath).Replace(
            Literal(BaselineHeightMax), Literal(heightMax), StringComparison.Ordinal);
        Repository.Put(Plugin, new SourceDocument(_npcFormKey, "npc_", NpcEditorId, body));
    }

    private static string Literal(float value) =>
        $"\"HeightMax\": {value.ToString("0.0#", System.Globalization.CultureInfo.InvariantCulture)}";

    private void CommitOnEditBranch(string message)
    {
        Git("add", "-A");
        Git("commit", "-q", "-m", message);
    }

    // What another tool leaves behind: a new pristine baseline on main, with the edit branch's own
    // history and working tree untouched.
    private void AbsorbUpstream(float heightMax, bool withNewRecord) =>
        SourceRepository.CommitPristineToMain(
            _modFolder,
            PluginBaselines.Of(TreeOf(Upstream(heightMax, withNewRecord))));

    [Fact]
    public void RebaseEditBranch_Refuses_OverUncommittedDirt()
    {
        EditHeightMax(0.3f);
        // Never committed — plain working-tree dirt.
        AbsorbUpstream(BaselineHeightMax, withNewRecord: true);

        var result = SourceRepository.RebaseEditBranch(_modFolder);

        Assert.Equal(RebaseOutcome.Refused, result.Outcome);
        Assert.Contains(_npcRelativePath.Replace('\\', '/'), result.RefusalReason, StringComparison.Ordinal);
        // Refused before touching anything: still on edit, still dirty exactly as before.
        Assert.Equal("edit", Git("rev-parse", "--abbrev-ref", "HEAD").Trim());
        Assert.NotEmpty(Git("status", "--porcelain"));
    }

    [Fact]
    public void RebaseEditBranch_ReplaysCleanly_WhenNothingOverlaps()
    {
        EditHeightMax(0.3f);
        CommitOnEditBranch("my own edit");
        AbsorbUpstream(BaselineHeightMax, withNewRecord: true);

        var result = SourceRepository.RebaseEditBranch(_modFolder);

        Assert.Equal(RebaseOutcome.Clean, result.Outcome);
        Assert.Equal("edit", Git("rev-parse", "--abbrev-ref", "HEAD").Trim());
        // Both sides survived the replay: my own edit's content, and upstream's new record.
        Assert.Contains(Literal(0.3f), File.ReadAllText(NpcFullPath), StringComparison.Ordinal);
        Assert.Contains(Repository.ReadAll(Plugin), document => document.EditorId == "BrandNewUpstreamNpc");
        var mainSha = Git("rev-parse", "refs/heads/main").Trim();
        Assert.Equal(mainSha, Git("merge-base", "refs/heads/main", "edit").Trim());
    }

    [Fact]
    public void RebaseEditBranch_LeavesTheSurvivingEditInTheSourceTree_WhereMainStillHoldsTheBaseline()
    {
        EditHeightMax(0.3f);
        CommitOnEditBranch("my own edit");
        AbsorbUpstream(BaselineHeightMax, withNewRecord: true);

        Assert.Equal(RebaseOutcome.Clean, SourceRepository.RebaseEditBranch(_modFolder).Outcome);

        // The edit survived the replay on the edit branch; main is upstream's own commit and never
        // carried it, so only the edit branch's tree can be what a reader of this value reads.
        var document = Repository.Get(Plugin, new RecordIdentity(_npcFormKey, "npc_", NpcEditorId));
        Assert.NotNull(document);
        Assert.Contains(Literal(0.3f), document.Body, StringComparison.Ordinal);
        Assert.Contains(
            Literal(BaselineHeightMax),
            Git("show", $"main:{_npcRelativePath.Replace('\\', '/')}"),
            StringComparison.Ordinal);
    }

    [Fact]
    public void RebaseEditBranch_Conflicts_OnOverlappingRecordEdits_AndTheResolvedResultIsReadableSource()
    {
        EditHeightMax(0.3f);
        CommitOnEditBranch("my own edit");
        AbsorbUpstream(0.7f, withNewRecord: false);

        var conflictResult = SourceRepository.RebaseEditBranch(_modFolder);

        var relative = _npcRelativePath.Replace('\\', '/');
        Assert.Equal(RebaseOutcome.Conflicted, conflictResult.Outcome);
        Assert.Contains(relative, conflictResult.ConflictedPaths);
        Assert.Contains("<<<<<<<", File.ReadAllText(NpcFullPath), StringComparison.Ordinal);

        // Hand-resolve exactly the way a user would in the native merge editor — here, taking the
        // replayed commit's side verbatim, which a rebase stages at :3 (still valid source text).
        File.WriteAllText(NpcFullPath, Git("show", $":3:{relative}"));

        var continueResult = SourceRepository.ContinueRebase(_modFolder);
        Assert.Equal(RebaseOutcome.Clean, continueResult.Outcome);
        Assert.Equal("edit", Git("rev-parse", "--abbrev-ref", "HEAD").Trim());
        Assert.Empty(Git("status", "--porcelain"));

        var resolved = Repository.Get(Plugin, new RecordIdentity(_npcFormKey, "npc_", NpcEditorId));
        Assert.NotNull(resolved);
        Assert.Contains(Literal(0.3f), resolved.Body, StringComparison.Ordinal);
    }

    [Fact]
    public void RebaseEditBranch_CalledAgainAfterAConflictIsResolved_ResumesRatherThanRefusing()
    {
        EditHeightMax(0.3f);
        CommitOnEditBranch("my own edit");
        AbsorbUpstream(0.7f, withNewRecord: false);

        var conflictResult = SourceRepository.RebaseEditBranch(_modFolder);
        Assert.Equal(RebaseOutcome.Conflicted, conflictResult.Outcome);

        var relative = _npcRelativePath.Replace('\\', '/');
        File.WriteAllText(NpcFullPath, Git("show", $":3:{relative}"));

        // The same verb, called again — not ContinueRebase directly.
        var secondResult = SourceRepository.RebaseEditBranch(_modFolder);

        Assert.Equal(RebaseOutcome.Clean, secondResult.Outcome);
        Assert.Equal("edit", Git("rev-parse", "--abbrev-ref", "HEAD").Trim());
    }
}
