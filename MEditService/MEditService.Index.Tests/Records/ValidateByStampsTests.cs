using MEditService.Index.Queries;
using MEditService.Index.Tests.TestSupport;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Index.Tests.Records;

public sealed class ValidateByStampsTests : IDisposable
{
    private readonly ScatteredFixtureData _fixture;
    private readonly LoadOrderEntry _mod;
    private readonly LoadOrderEntry _partner;
    private readonly InMemoryNotificationPublisher _notifications = new();
    private readonly OpenedIndex _index;
    private readonly string _npc;

    public ValidateByStampsTests()
    {
        FormKey npc = default;
        _fixture = new PluginFixtureBuilder("validate-by-stamps")
            .WithPlugin("Fixture.esp", mod => npc = mod.Npcs.AddNew("FixtureNpc").FormKey, origin: "FixtureMod")
            .WithPlugin("Partner.esp", mod => mod.Npcs.AddNew("PartnerNpc"), origin: "PartnerMod")
            .BuildScattered()
            .Tracked();
        _mod = _fixture.Plugins.Single(p => p.Name == "Fixture.esp");
        _partner = _fixture.Plugins.Single(p => p.Name == "Partner.esp");
        _npc = npc.ToString();
        _index = Indexes.Reconciled(_fixture, notifications: _notifications);
    }

    public void Dispose()
    {
        _index.Dispose();
        _fixture.Dispose();
    }

    private RecordDetail Npc => _index.DocumentOf(_npc, _mod.KeyOf());

    private WorkingTreeState NpcState =>
        _index.RowOf(_npc, _mod.KeyOf())?.WorkingTreeState ?? throw new InvalidOperationException($"Expected {_npc} to be listed.");

    private void Validate() => _index.NextSnapshot();

    private void ValidateUntilEditorId(string editorId) =>
        _index.NextSnapshotUntil(() => NpcNamed(editorId), $"the record named {editorId}");

    private bool NpcNamed(string editorId)
    {
        try
        {
            return _index.CopyIn(_npc, _mod.KeyOf())?.EditorId == editorId;
        }
        catch (IndexNotReadyException)
        {
            return false;
        }
    }

    private void ValidateUntilSourceUnreadable() =>
        _index.NextSnapshotUntil(() => SourceUnreadable, "the plugin file read in place of its source");

    private bool SourceUnreadable => _index.PluginRowOf(_mod.KeyOf()) is { IsTracked: true, PluginSourceUnreadable: true };

    private string NpcFile => _mod.SourceFileOf(Npc);

    private string ModRelativePath(string file) => Path.GetRelativePath(_mod.ModFolderOf(), file).Replace('\\', '/');

    [Fact]
    public void ADirtyDocumentUnchangedSinceTheLastValidation_IsNotAnnouncedAgain()
    {
        _mod.HandEdit(Npc, "\"FixtureNpc\"", "\"RenamedByHand\"");
        Validate();

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(_index));

        Assert.DoesNotContain(announced, Announcements.RowsChanged(_npc));
        Assert.DoesNotContain(announced, Announcements.PluginChanged(_mod));
    }

    [Fact]
    public void AHandEditOfTheSameLengthThatKeepsTheModificationTime_IsStillFound()
    {
        var file = NpcFile;
        var modified = File.GetLastWriteTimeUtc(file);
        File.WriteAllText(file, File.ReadAllText(file).Replace("\"FixtureNpc\"", "\"FixtureNpX\"", StringComparison.Ordinal));
        File.SetLastWriteTimeUtc(file, modified);

        ValidateUntilEditorId("FixtureNpX");

        Assert.Equal("FixtureNpX", Npc.EditorId);
    }

    [Fact]
    public void AHandEditThatIsRestored_ReturnsTheRecordToHead()
    {
        _mod.HandEdit(Npc, "\"FixtureNpc\"", "\"RenamedByHand\"");
        ValidateUntilEditorId("RenamedByHand");
        _mod.Git("checkout", "--", ModRelativePath(NpcFile));

        ValidateUntilEditorId("FixtureNpc");

        Assert.Equal(WorkingTreeState.None, NpcState);
        Assert.Equal("FixtureNpc", Npc.EditorId);
    }

    [Fact]
    public void ADeletedDocumentThatIsRestored_ComesBack()
    {
        var file = NpcFile;
        File.Delete(file);
        _index.NextSnapshotUntil(() => _index.CopyIn(_npc, _mod.KeyOf()) is null, "the record gone");
        _mod.Git("checkout", "--", ModRelativePath(file));

        ValidateUntilEditorId("FixtureNpc");

        Assert.Equal("FixtureNpc", Npc.EditorId);
        Assert.Equal(WorkingTreeState.None, NpcState);
    }

    [Fact]
    public void AnUncommittedDocumentDeletedByHand_LosesItsRows()
    {
        const string created = "000900:Fixture.esp";
        _index.Create(_mod, created, "npc_", "CreatedNpc",
            _index.BodyOf(_npc, _mod.KeyOf())
                .Replace(_npc, created, StringComparison.Ordinal)
                .Replace("\"FixtureNpc\"", "\"CreatedNpc\"", StringComparison.Ordinal));
        File.Delete(_mod.SourceFileOf(_index.DocumentOf(created, _mod.KeyOf())));

        Validate();

        Assert.Null(_index.CopyIn(created, _mod.KeyOf()));
    }

    [Fact]
    public void ADocumentTheHandEditedToDeclareNoFormKey_LeavesThePluginFilesRowsInItsPlace()
    {
        File.WriteAllText(NpcFile, "{\"EditorID\":\"NoFormKey\"}");

        ValidateUntilSourceUnreadable();

        Assert.Equal("FixtureNpc", Npc.EditorId);
        Assert.Empty(_index.Status.Failures);
    }

    [Fact]
    public void ADocumentThatCouldNotBeRead_IsRefreshedByTheNextValidation()
    {
        _mod.HandEdit(Npc, "\"FixtureNpc\"", "\"RenamedByHand\"");
        Validate();
        Assert.Equal(WorkingTreeState.Modified, NpcState);
        using (new FileStream(NpcFile, FileMode.Open, FileAccess.Read, FileShare.None))
            ValidateUntilSourceUnreadable();
        Assert.Equal("FixtureNpc", Npc.EditorId);

        Validate();

        Assert.Equal("RenamedByHand", Npc.EditorId);
    }

    [Fact]
    public void ADocumentDeclaringNoRecord_LeavesThePluginSourceUnreadable_AtTheNextValidationToo()
    {
        var stray = Path.Combine(Path.GetDirectoryName(NpcFile).Require(), "Stray - 000A00_Fixture.esp.json");
        File.WriteAllText(stray, "{\"EditorID\":\"Stray\"}");
        ValidateUntilSourceUnreadable();

        _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(_index));

        Assert.True(SourceUnreadable);
    }

    [Fact]
    public void ATreeThatReturns_ReplacesTheBinarysRows()
    {
        _mod.HandEdit(Npc, "\"FixtureNpc\"", "\"RenamedByHand\"");
        Validate();
        var treeThatLeavesAndReturns = PluginSourceRoot.In(_mod.ModFolderOf(), _mod.Name);
        Directory.Move(treeThatLeavesAndReturns, treeThatLeavesAndReturns + ".away");
        ValidateUntilEditorId("FixtureNpc");
        Directory.Move(treeThatLeavesAndReturns + ".away", treeThatLeavesAndReturns);

        ValidateUntilEditorId("RenamedByHand");

        Assert.Equal("RenamedByHand", Npc.EditorId);
    }

    [Fact]
    public void AStagedRenameOfADocument_LeavesItsRecordUnchanged()
    {
        var document = NpcFile;
        var renamed = Path.Combine(Path.GetDirectoryName(document).Require(), Path.GetFileName(document).Replace("FixtureNpc - ", "Renamed - ", StringComparison.Ordinal));
        _mod.Git("mv", ModRelativePath(document), ModRelativePath(renamed));

        using var index = Indexes.Reconciled(_fixture);

        Assert.Equal(WorkingTreeState.None, index.ListedIn(_mod.KeyOf()).Single(i => i.FormKey == _npc).WorkingTreeState);
    }

    [Fact]
    public void ACopyOfADocument_IsReportedWithBothDocuments()
    {
        var document = NpcFile;
        var copyNamedWithTheFormKeySuffix =
            $"Twin - {Path.GetFileName(document).Split(" - ")[^1]}";
        var copy = Path.Combine(Path.GetDirectoryName(document).Require(), copyNamedWithTheFormKeySuffix);
        File.Copy(document, copy);

        ValidateUntilSourceUnreadable();

        Assert.Equal("FixtureNpc", Npc.EditorId);
        var problems = _index.Problems.GetProblems() ?? throw new InvalidOperationException("Expected the index to be ready.");
        Assert.Equivalent(
            new[] { Path.GetRelativePath(_mod.ModFolderOf(), document), Path.GetRelativePath(_mod.ModFolderOf(), copy) },
            problems.Single(p => PluginAddress.Comparer.Equals(p.Plugin, _mod.KeyOf())).Problems.Select(p => p.SourceRelativePath),
            strict: true);
    }

    [Fact]
    public void ValidatingEveryPlugin_WhenOnePluginsTreeCannotBeRead_StillValidatesTheOthers()
    {
        FormKey other = default;
        using var fixture = new PluginFixtureBuilder("validate-two-tracked")
            .WithPlugin("Broken.esp", mod => mod.Npcs.AddNew("BrokenNpc"), origin: "BrokenMod")
            .WithPlugin("Sound.esp", mod => other = mod.Npcs.AddNew("SoundNpc").FormKey, origin: "SoundMod")
            .BuildScattered()
            .Tracked();
        using var index = Indexes.Reconciled(fixture);
        var broken = fixture.Plugins.Single(p => p.Name == "Broken.esp");
        var sound = fixture.Plugins.Single(p => p.Name == "Sound.esp");
        var brokenDocument = broken.SourceFileOf(index.DocumentOf(index.ListedIn(broken.KeyOf()).Single().FormKey, broken.KeyOf()));
        var backup = Path.Combine(Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(brokenDocument).Require(), "Backup")).FullName, Path.GetFileName(brokenDocument));
        File.Copy(brokenDocument, backup);
        sound.HandEdit(index.DocumentOf(other.ToString(), sound.KeyOf()), "\"SoundNpc\"", "\"EditedSoundNpc\"");

        index.NextSnapshotUntil(
            () => index.PluginRowOf(broken.KeyOf()) is { IsTracked: true, PluginSourceUnreadable: true },
            "the broken plugin's file read in place of its source");

        Assert.Equal("EditedSoundNpc", index.DocumentOf(other.ToString(), sound.KeyOf()).EditorId);
    }

}
