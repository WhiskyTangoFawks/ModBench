using MEditService.LoadOrder;
using MEditService.RecordIndex.Tests.TestSupport;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex.Tests.Query;

public sealed class RecordNameLanguageTests
{
    [Theory]
    [InlineData(Language.English, "Abraxo Cleaner")]
    [InlineData(Language.French, "Nettoyant Abraxo")]
    public void ARecordsListedName_IsItsNameInTheStringsLanguage(Language stringsLanguage, string name)
    {
        using var copies = new LocalizedCopies(stringsLanguage);

        var listed = copies.Index.Queries.GetRecords(["misc"], LocalizedCopies.Master, search: null, limit: 10, offset: 0).Value();

        Assert.Equal(name, listed.Items.Single().FullName);
    }

    [Fact]
    public void ASourceTreeRecordsListedName_FollowsTheStringsLanguageWhenItMoves()
    {
        const string origin = "Doors";
        var item = new FormKey(ModKey.FromFileName("Tree.esp"), 0x800);
        using var fixture = new PluginFixtureBuilder("medit-tree-name-language")
            .WithPlugin("Tree.esp", mod =>
            {
                mod.UsingLocalization = true;
                mod.MiscItems.Add(new MiscItem(item, Fallout4Release.Fallout4)
                {
                    EditorID = "Abraxo",
                    Name = new TranslatedString(Language.English, [new(Language.English, "Abraxo Cleaner"), new(Language.French, "Nettoyant Abraxo")]),
                });
            }, origin: origin)
            .Build();
        var entry = fixture.Plugins.Single();
        SourceMods.Init(entry);
        var holder = new LoadOrderHolder();
        using var index = Indexes.Open(holder);

        string? NameIn(Language language)
        {
            index.Receive(holder, SnapshotPlugins.Snapshot(fixture.DataFolder, null, GameRelease.Fallout4, fixture.Plugins, stringsLanguage: language));
            return index.Queries.GetRecords(["misc"], entry.Key, search: null, limit: 10, offset: 0).Value().Items.Single().FullName;
        }

        var names = new[] { NameIn(Language.English), NameIn(Language.French) };

        Assert.Equal(new[] { "Abraxo Cleaner", "Nettoyant Abraxo" }, names);
    }
}
