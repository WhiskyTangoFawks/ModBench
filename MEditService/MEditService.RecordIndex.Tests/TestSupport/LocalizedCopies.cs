using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Strings;

namespace MEditService.RecordIndex.Tests.TestSupport;

/// <summary>A.esp, localized in English and French, and B.esp, not localized, copying A's records unchanged
/// into the strings language the index reads in.</summary>
internal sealed class LocalizedCopies : IDisposable
{
    internal static readonly PluginAddress Master = new("A.esp", PluginOrigin.DataDirectory);
    internal static readonly PluginAddress Copy = new("B.esp", PluginOrigin.DataDirectory);
    internal static readonly FormKey Item = new(ModKey.FromFileName(Master.Name), 0x800);
    internal static readonly FormKey Message = new(ModKey.FromFileName(Master.Name), 0x801);

    private static readonly Dictionary<Language, (string Name, string Description, string Button)> Texts = new()
    {
        [Language.English] = ("Abraxo Cleaner", "Clean it?", "Yes"),
        [Language.French] = ("Nettoyant Abraxo", "Le nettoyer ?", "Oui"),
    };

    private readonly PluginFixtureData _fixture;

    internal OpenedIndex Index { get; }

    internal LocalizedCopies(Language stringsLanguage)
    {
        var copied = Texts[stringsLanguage];
        _fixture = new PluginFixtureBuilder("medit-localized-copies")
            .WithPlugin(Master.Name, mod =>
            {
                mod.UsingLocalization = true;
                mod.MiscItems.Add(new MiscItem(Item, Fallout4Release.Fallout4) { EditorID = "AbraxoCleaner", Name = InEveryLanguage(t => t.Name) });
                mod.Messages.Add(MessageHolding(InEveryLanguage(t => t.Description), InEveryLanguage(t => t.Button)));
            })
            .WithPlugin(Copy.Name, mod =>
            {
                mod.MiscItems.Set(new MiscItem(Item, Fallout4Release.Fallout4) { EditorID = "AbraxoCleaner", Name = copied.Name });
                mod.Messages.Set(MessageHolding(copied.Description, copied.Button));
            })
            .Build();
        var holder = new LoadOrderHolder();
        Index = Indexes.Open(holder);
        Index.Receive(holder, SnapshotPlugins.Snapshot(_fixture.DataFolder, null, GameRelease.Fallout4, _fixture.Plugins, stringsLanguage: stringsLanguage));
    }

    private static TranslatedString InEveryLanguage(Func<(string Name, string Description, string Button), string> text) =>
        new(Language.English, Texts.Select(t => new KeyValuePair<Language, string>(t.Key, text(t.Value))));

    private static Message MessageHolding(TranslatedString description, TranslatedString button) =>
        new(Message, Fallout4Release.Fallout4)
        {
            EditorID = "AbraxoPrompt",
            Description = description,
            MenuButtons = [new MessageButton { Text = button }],
        };

    public void Dispose()
    {
        Index.Dispose();
        _fixture.Dispose();
    }
}
