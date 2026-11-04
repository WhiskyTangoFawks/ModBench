using MEditService.Codec.Schema;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;

namespace MEditService.TestSupport;

/// <summary>A plugin holding one reference flagged Deleted that still names its base record, as the
/// Creation Kit leaves it and Mutagen reads it.</summary>
public static class DeletedReferencePlugin
{
    private const uint BaseRecordId = 0x801;

    public static byte[] Bytes(string fileName, params (string Signature, byte[] Payload)[] otherFields) =>
        BytesOf(fileName, formKey => new PlacedObject(formKey, Fallout4Release.Fallout4), otherFields);

    /// <summary>The reference is a trap, whose NAME Mutagen reads into its Projectile.</summary>
    public static byte[] TrapBytes(string fileName) =>
        BytesOf(fileName, formKey => new PlacedMissile(formKey, Fallout4Release.Fallout4), []);

    private static byte[] BytesOf(string fileName, Func<FormKey, IPlaced> reference, (string Signature, byte[] Payload)[] otherFields)
    {
        var mod = new Fallout4Mod(ModKey.FromFileName(fileName), Fallout4Release.Fallout4);
        var cell = new Cell(mod.GetNextFormKey(), Fallout4Release.Fallout4) { EditorID = "HarborCell" };
        var placed = reference(mod.GetNextFormKey());
        placed.MajorRecordFlagsRaw = (int)DeletedFlag.Bit;
        cell.Persistent.Add(placed);
        mod.AddInteriorCells(cell);
        using var stream = new MemoryStream();
        mod.WriteToBinary(stream);
        return RawPlugin.EditRecord(stream.ToArray(), placed.FormKey.ID, _ => [("NAME", RawPlugin.U32(BaseRecordId)), .. otherFields]);
    }
}
