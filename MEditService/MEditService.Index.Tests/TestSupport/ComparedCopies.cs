using System.Text.Json.Nodes;
using MEditService.Index.Queries;
using MEditService.LoadOrder;
using MEditService.TestSupport;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.Index.Tests.TestSupport;

/// <summary>One record copied in A.esp, B.esp, ... in that load order, each copy a fresh record its
/// own setter fills, written by Mutagen into the Data directory, indexed and compared through the face.</summary>
internal static class ComparedCopies
{
    internal static readonly ModKey Master = ModKey.FromFileName(PluginAt(0));

    internal static readonly FormKey Record = new(Master, 0x800);

    internal static FormKey InMaster(uint id) => new(Master, id);

    internal static string PluginAt(int place) => $"{(char)('A' + place)}.esp";

    internal static CompareResult Of<T>(params Action<T>[] copies)
        where T : class, IFallout4MajorRecordInternal =>
        Compare(_ => { }, spelled: null, copies);

    /// <summary>The copies, with the records they name written into the master beside its copy.</summary>
    internal static CompareResult Beside<T>(Action<Fallout4Mod> alongsideTheMastersCopy, params Action<T>[] copies)
        where T : class, IFallout4MajorRecordInternal =>
        Compare(alongsideTheMastersCopy, spelled: null, copies);

    /// <summary>The copies, with <paramref name="plugin"/>'s column read from the document it holds as
    /// <paramref name="spell"/> rewrites it: a spelling only a hand-written document holds.</summary>
    internal static CompareResult Spelled<T>(string plugin, Action<JsonObject> spell, params Action<T>[] copies)
        where T : class, IFallout4MajorRecordInternal =>
        Compare(_ => { }, (plugin, spell), copies);

    private static CompareResult Compare<T>(
        Action<Fallout4Mod> alongsideTheMastersCopy, (string Plugin, Action<JsonObject> Spell)? spelled, Action<T>[] copies)
        where T : class, IFallout4MajorRecordInternal
    {
        var builder = new PluginFixtureBuilder("medit-compared-copies");
        for (var place = 0; place < copies.Length; place++)
        {
            var set = copies[place];
            var isMaster = place == 0;
            builder.WithPlugin(PluginAt(place), mod =>
            {
                if (isMaster) alongsideTheMastersCopy(mod);
                var copy = System.Activator.CreateInstance(typeof(T), Record, Fallout4Release.Fallout4) as T
                    ?? throw new InvalidOperationException($"{typeof(T).Name} has no constructor from a FormKey and a release.");
                set(copy);
                ((IMod)mod).GetTopLevelGroup<T>().Set(copy);
            });
        }

        using var fixture = builder.Build();
        using var index = Indexes.Reconciled(fixture);
        CopyText? text = null;
        if (spelled is var (plugin, spell))
        {
            var address = new PluginAddress(plugin, PluginOrigin.DataDirectory);
            var document = JsonNode.Parse(index.BodyOf(Record.ToString(), address)) as JsonObject
                ?? throw new InvalidOperationException($"{plugin}'s document is no object.");
            spell(document);
            text = new CopyText(address, document.ToJsonString());
        }
        return index.Queries.GetCompare(Record.ToString(), text).Value()
            ?? throw new InvalidOperationException($"Expected {Record} to compare.");
    }
}
