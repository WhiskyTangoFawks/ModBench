using System.Reflection;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.TestSupport;

/// <summary>One malformation's sample: a record as another tool writes it, the change the repair
/// engine names for it, and, where a repair answers it, the plugin Mutagen wrote before the record was
/// malformed, which the repair restores.</summary>
public sealed record MalformationFixture(string Malformation, GeneratedPlugin Malformed, string Diagnosis, string? Change, byte[]? Repaired)
{
    public override string ToString() => Malformation;
}

/// <summary>A malformation's fixture is a property of this class named for it.</summary>
public static class MalformationFixtures
{
    private const string FileName = "Malformed Records.esp";

    public static IReadOnlyList<MalformationFixture> All =>
    [
        .. typeof(MalformationFixtures).GetProperties(BindingFlags.NonPublic | BindingFlags.Static)
            .Where(property => property.PropertyType == typeof(MalformationFixture))
            .Select(property => property.GetValue(null))
            .OfType<MalformationFixture>(),
    ];

    /// <summary>A REGN whose RDAT is short.</summary>
    public static MalformationFixture ShortRegion => ShortFixedSizeSubrecord;

    private static MalformationFixture ShortFixedSizeSubrecord
    {
        get
        {
            var mod = NewMod();
            var region = mod.Regions.AddNew("HarborRegion");
            region.Map = new RegionMap { Name = "Harbor" };
            return Malformed(nameof(ShortFixedSizeSubrecord), mod, "REGN", region,
                ShortenRdat,
                "fixed-size-subrecord-short, repairable (lossless): RDAT is 6 bytes; a REGN RDAT is always 8",
                "pads RDAT from 6 to 8 bytes with zeros");
        }
    }

    /// <summary>A plugin Mutagen fails to read at its RACE and reads with loss at its REGN, each malformed
    /// and repairable.</summary>
    public static GeneratedPlugin ShortRegionBesideAWrongCountRace
    {
        get
        {
            var mod = NewMod();
            var region = mod.Regions.AddNew("HarborRegion");
            region.Map = new RegionMap { Name = "Harbor" };
            var race = mod.Races.AddNew("HarborRace");
            using var stream = new MemoryStream();
            mod.WriteToBinary(stream);
            var shortened = RawPlugin.EditRecord(stream.ToArray(), region.FormKey.ID, ShortenRdat);
            return new GeneratedPlugin(FileName, RawPlugin.EditRecord(shortened, race.FormKey.ID, DropLastName));
        }
    }

    private static IEnumerable<(string Signature, byte[] Payload)> ShortenRdat(List<(string Signature, byte[] Payload)> subrecords) =>
        subrecords.Select(s => s.Signature == "RDAT" ? (s.Signature, s.Payload[..6]) : s);

    private static IEnumerable<(string Signature, byte[] Payload)> DropLastName(List<(string Signature, byte[] Payload)> subrecords) =>
        subrecords.Where((s, i) => i != subrecords.FindLastIndex(n => n.Signature == "NAME"));

    private static MalformationFixture ShortFixedSizeSubrecordOfAPerk
    {
        get
        {
            var mod = NewMod();
            var perk = mod.Perks.AddNew("FTS_CallMarkerPerk");
            perk.Effects.Add(new PerkEntryPointAddActivateChoice { ButtonLabel = "Call", Flags = 0 });
            return Malformed(nameof(ShortFixedSizeSubrecord), mod, "PERK", perk,
                subrecords => subrecords.Select(s => s.Signature == "EPF3" ? (s.Signature, s.Payload[..1]) : s),
                "fixed-size-subrecord-short, repairable (lossless): EPF3 is 1 bytes; a PERK EPF3 is always 2",
                "pads EPF3 from 1 to 2 bytes with zeros");
        }
    }

    private static MalformationFixture WrongFixedCountList
    {
        get
        {
            var mod = NewMod();
            var race = mod.Races.AddNew("HarborRace");
            return Malformed(nameof(WrongFixedCountList), mod, "RACE", race,
                DropLastName,
                "fixed-count-list-wrong-count, repairable (lossless): NAME appears 31 times; the Creation Kit always writes 32",
                "inserts 1 zeroed NAME of 1 byte before RBPC");
        }
    }

    private static MalformationFixture CounterDisagreeingWithEntries
    {
        get
        {
            var mod = NewMod();
            var reference = new PlacedObject(mod.GetNextFormKey(), Fallout4Release.Fallout4) { EditorID = "HarborWorkshopRef" };
            reference.PowerGridConnections = [new PowerGridConnection(), new PowerGridConnection()];
            var cell = new Cell(mod.GetNextFormKey(), Fallout4Release.Fallout4) { EditorID = "HarborCell" };
            cell.Persistent.Add(reference);
            mod.AddInteriorCells(cell);
            return Malformed(nameof(CounterDisagreeingWithEntries), mod, "REFR", reference,
                subrecords => subrecords.Select(s => s.Signature == "XWPG" ? (s.Signature, RawPlugin.U32(1)) : s),
                "counter-entries-mismatch, repairable (lossless): XWPG counts 1; 2 XWPN entries follow",
                "sets XWPG from 1 to 2");
        }
    }

    private static MalformationFixture TemplateCombinationOutOfOrder
    {
        get
        {
            var mod = NewMod();
            var weapon = mod.Weapons.AddNew("GaussRevolver");
            weapon.ObjectTemplates = [new ObjectTemplate<Weapon.Property> { IsEditorOnly = true, Name = "Gauss Revolver" }];
            return Malformed(nameof(TemplateCombinationOutOfOrder), mod, "WEAP", weapon,
                subrecords =>
                {
                    var obts = subrecords.FindIndex(s => s.Signature == "OBTS");
                    var obtf = subrecords.FindIndex(s => s.Signature == "OBTF");
                    return [.. subrecords[..obtf], subrecords[obts], .. subrecords[obtf..obts], .. subrecords[(obts + 1)..]];
                },
                "subrecord-out-of-ck-order, repairable (lossless): template combination 0's OBTS precedes its OBTF/FULL; the Creation Kit writes OBTF, FULL, OBTS",
                "moves OBTS before STOP");
        }
    }

    private static MalformationFixture EntryPointParametersOnAParameterlessFunction
    {
        get
        {
            var mod = NewMod();
            var perk = mod.Perks.AddNew("Sniper03");
            perk.Effects.Add(new PerkEntryPointAbsoluteValue());
            return Malformed(nameof(EntryPointParametersOnAParameterlessFunction), mod, "PERK", perk,
                subrecords => subrecords.SelectMany<(string Signature, byte[] Payload), (string, byte[])>(s => s.Signature == "PRKF"
                    ? [("EPFT", [1]), ("EPFB", new byte[2]), ("EPFD", new byte[4]), s]
                    : [s]),
                "entry-point-parameter-shape, repairable (drops 25 bytes): entry point 0 (function 6, Absolute Value) has EPFT 1; vanilla writes no parameters",
                "drops EPFT, EPFB, EPFD (25 bytes)");
        }
    }

    private static MalformationFixture EntryPointMissingEpf3
    {
        get
        {
            var mod = NewMod();
            var perk = mod.Perks.AddNew("FTS_CallMarkerPerk");
            perk.Effects.Add(new PerkEntryPointAddActivateChoice { ButtonLabel = "Call", Flags = 0 });
            return Malformed(nameof(EntryPointMissingEpf3), mod, "PERK", perk,
                subrecords => subrecords.Where(s => s.Signature != "EPF3"),
                "entry-point-parameter-shape, repairable (lossless): entry point 0 (function 9, Add Activate Choice) is missing EPF3; vanilla always writes it",
                "inserts 1 zeroed EPF3 of 2 bytes before PRKF");
        }
    }

    private static MalformationFixture EntryPointParameterOfAnotherType => new(
        nameof(EntryPointParameterOfAnotherType), MisshapedPerkPlugin.Plugin,
        $"{MisshapedPerkPlugin.Anchor} — entry-point-parameter-shape: entry point 1 (function 14, Multiply 1 + Actor Value Mult) has EPFT 2; vanilla writes EPFT 8",
        Change: null, Repaired: null);

    private static Fallout4Mod NewMod() => new(ModKey.FromFileName(FileName), Fallout4Release.Fallout4);

    private static MalformationFixture Malformed(
        string malformation, Fallout4Mod mod, string signature, IMajorRecordGetter record,
        Func<List<(string Signature, byte[] Payload)>, IEnumerable<(string Signature, byte[] Payload)>> malform,
        string diagnosis, string change)
    {
        using var stream = new MemoryStream();
        mod.WriteToBinary(stream);
        var written = stream.ToArray();
        var formId = record.FormKey.ID;
        return new MalformationFixture(malformation, new GeneratedPlugin(FileName, RawPlugin.EditRecord(written, formId, malform)),
            $"{signature} {formId:X8} ({record.EditorID}) — {diagnosis}", change, written);
    }
}
