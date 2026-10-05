using MEditService.Index.Tests.TestSupport;
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

    private IRecordReads Reads => _index.RequireReads();

    private void Validate() => _index.NextSnapshot();

    private void ValidateUntilEditorId(string editorId) =>
        _index.NextSnapshotUntil(() => Reads.GetDocument(_npc, _mod.KeyOf())?.EditorId == editorId, $"the record named {editorId}");

    private void ValidateUntilFailed() => _index.NextSnapshotUntil(() => PluginFailed, "the plugin's failure");

    private bool PluginFailed => _index.Status.Failures.Any(f => f.Name == _mod.Name);

    private string NpcFile => _mod.SourceFileOf(Reads.DocumentOf(_npc, _mod.KeyOf()));

    private string ModRelativePath(string file) => Path.GetRelativePath(_mod.ModFolderOf(), file).Replace('\\', '/');

    [Fact]
    public void ADirtyDocumentUnchangedSinceTheLastValidation_IsNotAnnouncedAgain()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        Validate();

        var announced = _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(Reads));

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

        Assert.Equal("FixtureNpX", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
    }

    [Fact]
    public void AHandEditThatIsRestored_ReturnsTheRecordToHead()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        ValidateUntilEditorId("RenamedByHand");
        _mod.Git("checkout", "--", ModRelativePath(NpcFile));

        ValidateUntilEditorId("FixtureNpc");

        var entry = Reads.StackEntry(_npc, _mod.KeyOf()).Require();
        Assert.False(entry.HasWorkingTreeChange);
        Assert.Equal("FixtureNpc", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
    }

    [Fact]
    public void ADeletedDocumentThatIsRestored_ComesBack()
    {
        var file = NpcFile;
        File.Delete(file);
        _index.NextSnapshotUntil(() => Reads.GetDocument(_npc, _mod.KeyOf()) is null, "the record gone");
        _mod.Git("checkout", "--", ModRelativePath(file));

        ValidateUntilEditorId("FixtureNpc");

        Assert.Equal("FixtureNpc", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
        Assert.False(Reads.StackEntry(_npc, _mod.KeyOf()).Require().HasWorkingTreeChange);
    }

    [Fact]
    public void AnUncommittedDocumentDeletedByHand_LosesItsRows()
    {
        const string created = "000900:Fixture.esp";
        _index.Create(_mod, created, "npc_", "CreatedNpc",
            Reads.DocumentOf(_npc, _mod.KeyOf()).BodyOf()
                .Replace(_npc, created, StringComparison.Ordinal)
                .Replace("\"FixtureNpc\"", "\"CreatedNpc\"", StringComparison.Ordinal));
        File.Delete(_mod.SourceFileOf(Reads.DocumentOf(created, _mod.KeyOf())));

        Validate();

        Assert.Null(Reads.GetDocument(created, _mod.KeyOf()));
    }

    [Fact]
    public void ADocumentTheHandEditedToDeclareNoFormKey_FailsThePlugin_AndKeepsItsRows()
    {
        File.WriteAllText(NpcFile, "{\"EditorID\":\"NoFormKey\"}");

        ValidateUntilFailed();

        Assert.Equal("FixtureNpc", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
    }

    [Fact]
    public void ADocumentThatCouldNotBeRead_IsRefreshedByTheNextValidation()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        Validate();
        Assert.True(Reads.StackEntry(_npc, _mod.KeyOf()).Require().HasWorkingTreeChange);
        using (new FileStream(NpcFile, FileMode.Open, FileAccess.Read, FileShare.None))
            ValidateUntilFailed();
        Assert.True(PluginFailed);

        Validate();

        Assert.Equal("RenamedByHand", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
    }

    [Fact]
    public void ADocumentDeclaringNoRecord_FailsThePlugin_AndStillFailsItOnTheNextValidation()
    {
        var stray = Path.Combine(Path.GetDirectoryName(NpcFile).Require(), "Stray - 000A00_Fixture.esp.json");
        File.WriteAllText(stray, "{\"EditorID\":\"Stray\"}");
        ValidateUntilFailed();
        Assert.True(PluginFailed);

        _index.AnnouncedByEqualArrivals(_notifications, () => _partner.RenamedByHand(Reads));

        Assert.True(PluginFailed);
    }

    [Fact]
    public void ATreeThatReturns_ReplacesTheBinarysRows()
    {
        _mod.HandEdit(Reads.DocumentOf(_npc, _mod.KeyOf()), "\"FixtureNpc\"", "\"RenamedByHand\"");
        Validate();
        var treeThatLeavesAndReturns = PluginSourceRoot.In(_mod.ModFolderOf(), _mod.Name);
        Directory.Move(treeThatLeavesAndReturns, treeThatLeavesAndReturns + ".away");
        ValidateUntilEditorId("FixtureNpc");
        Directory.Move(treeThatLeavesAndReturns + ".away", treeThatLeavesAndReturns);

        ValidateUntilEditorId("RenamedByHand");

        Assert.Equal("RenamedByHand", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
    }

    [Fact]
    public void AStagedRenameOfADocument_LeavesItsRecordUnchanged()
    {
        var document = NpcFile;
        var renamed = Path.Combine(Path.GetDirectoryName(document).Require(), Path.GetFileName(document).Replace("FixtureNpc - ", "Renamed - ", StringComparison.Ordinal));
        _mod.Git("mv", ModRelativePath(document), ModRelativePath(renamed));

        using var index = Indexes.Reconciled(_fixture);

        var listing = index.RequireReads().Search(new RecordQuery(Plugin: _mod.Name, Origin: _mod.Origin, RecordTypes: ["npc_"], Limit: 50));
        Assert.Equal(WorkingTreeState.None, listing.Items.Single(i => i.FormKey == _npc).WorkingTreeState);
    }

    [Fact]
    public void ACopyOfADocument_IsReportedWithBothDocuments()
    {
        var document = NpcFile;
        var copyNamedWithTheFormKeySuffix =
            $"Twin - {Path.GetFileName(document).Split(" - ")[^1]}";
        var copy = Path.Combine(Path.GetDirectoryName(document).Require(), copyNamedWithTheFormKeySuffix);
        File.Copy(document, copy);

        ValidateUntilFailed();

        Assert.Equal("FixtureNpc", Reads.DocumentOf(_npc, _mod.KeyOf()).EditorId);
        var failure = Assert.Single(_index.Status.Failures);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolderOf(), document), failure.Reason, StringComparison.Ordinal);
        Assert.Contains(Path.GetRelativePath(_mod.ModFolderOf(), copy), failure.Reason, StringComparison.Ordinal);
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
        var brokenDocument = broken.SourceFileOf(index.RequireReads().DocumentOf(
            index.RequireReads().Search(new RecordQuery(Plugin: broken.Name, Origin: broken.Origin, RecordTypes: ["npc_"], Limit: 1)).Items.Single().FormKey,
            broken.KeyOf()));
        var backup = Path.Combine(Directory.CreateDirectory(Path.Combine(Path.GetDirectoryName(brokenDocument).Require(), "Backup")).FullName, Path.GetFileName(brokenDocument));
        File.Copy(brokenDocument, backup);
        sound.HandEdit(index.RequireReads().DocumentOf(other.ToString(), sound.KeyOf()), "\"SoundNpc\"", "\"EditedSoundNpc\"");

        index.NextSnapshot();

        Assert.Equal("EditedSoundNpc", index.RequireReads().DocumentOf(other.ToString(), sound.KeyOf()).EditorId);
        Assert.Contains(index.Status.Failures, f => f.Name == "Broken.esp");
    }

}
