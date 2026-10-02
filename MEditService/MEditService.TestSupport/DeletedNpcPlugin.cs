using System.Text;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Mutagen.Bethesda.Plugins.Records;

namespace MEditService.TestSupport;

/// <summary>A plugin holding one NPC flagged Deleted, as bytes Mutagen's overlay throws serializing:
/// its ACBS is absent.</summary>
public static class DeletedNpcPlugin
{
    private const int DeletedFlag = 0x20;
    private const int RecordFlagsOffset = 8;

    /// <summary>The NPC holds no subrecord at all, as xEdit's Delete leaves it.</summary>
    public static void WriteEmpty(string path, FormKey npc, params ModKey[] masters) =>
        Write(path, masters, new Npc(npc, Fallout4Release.Fallout4) { MajorRecordFlagsRaw = DeletedFlag });

    /// <summary>The NPC still holds field subrecords, its name among them, beside the absent ACBS.</summary>
    public static void WriteHoldingFields(string path, FormKey npc, params ModKey[] masters)
    {
        Write(path, masters, new Npc(npc, Fallout4Release.Fallout4) { EditorID = "Guy", Name = "Guy" });
        var bytes = File.ReadAllBytes(path);
        var record = IndexOf(bytes, "NPC_", IndexOf(bytes, "NPC_", 0) + 4);
        var flags = BitConverter.ToInt32(bytes, record + RecordFlagsOffset) | DeletedFlag;
        BitConverter.GetBytes(flags).CopyTo(bytes, record + RecordFlagsOffset);
        Encoding.ASCII.GetBytes("ZZZZ").CopyTo(bytes, IndexOf(bytes, "ACBS", record));
        File.WriteAllBytes(path, bytes);
    }

    private static void Write(string path, ModKey[] masters, Npc record)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(Path.GetFileName(path)), Fallout4Release.Fallout4);
        foreach (var master in masters) mod.ModHeader.MasterReferences.Add(new MasterReference { Master = master });
        mod.Npcs.Add(record);
        mod.WriteToBinary(path);
    }

    private static int IndexOf(byte[] bytes, string signature, int from)
    {
        var needle = Encoding.ASCII.GetBytes(signature);
        var at = bytes.AsSpan(from).IndexOf(needle);
        return at < 0 ? throw new InvalidOperationException($"No {signature} after byte {from}.") : from + at;
    }
}
