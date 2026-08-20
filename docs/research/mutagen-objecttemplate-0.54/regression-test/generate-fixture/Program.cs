using Mutagen.Bethesda;
using Mutagen.Bethesda.Fallout4;
using Mutagen.Bethesda.Plugins;
using Noggog;

var outPath = args[0];
var modKey = ModKey.FromNameAndExtension("ObjectTemplateOrder.esp");

var mod = new Fallout4Mod(modKey, Fallout4Release.Fallout4);
var weapon = mod.Weapons.AddNew();
weapon.EditorID = "ObjectTemplateOrderRegressionTestWeapon";
weapon.ObjectTemplates = new ExtendedList<ObjectTemplate<Weapon.Property>>
{
    new ObjectTemplate<Weapon.Property>
    {
        IsEditorOnly = true,
        Name = "Regression Template",
    }
};

var workDir = Directory.CreateTempSubdirectory("fixture385-");
var modPath = Path.Combine(workDir.FullName, modKey.FileName);
mod.BeginWrite
    .ToPath(modPath)
    .WithLoadOrderFromHeaderMasters()
    .WithDataFolder((DirectoryPath?)null)
    .WriteAsync().GetAwaiter().GetResult();

var full = File.ReadAllBytes(modPath);
Console.WriteLine($"Full mod file: {full.Length} bytes");

// Locate the WEAP record: skip TES4 header record + Weapon GRUP header (24 bytes), leaving just
// the raw WEAP major record bytes (header + content) -- the shape ASpecificCaseTest's
// TestDataPathing.GetReadFrame/GetOverlayStream expect (File.ReadAllBytes fed straight into
// LoquiBinaryTranslation<Weapon>.Instance.Parse / LoquiBinaryOverlayTranslation<IWeaponGetter>.Create).
int pos = 0;
string PeekType(int p) => System.Text.Encoding.ASCII.GetString(full, p, 4);
uint ReadLen(int p) => BitConverter.ToUInt32(full, p + 4);

var tes4Type = PeekType(0);
if (tes4Type != "TES4") throw new InvalidOperationException($"Expected TES4 at 0, got {tes4Type}");
var tes4Len = ReadLen(0);
pos = 24 + (int)tes4Len; // 24-byte record header + content

var grupType = PeekType(pos);
if (grupType != "GRUP") throw new InvalidOperationException($"Expected GRUP at {pos}, got {grupType}");
pos += 24; // GRUP header is 24 bytes

var weapType = PeekType(pos);
if (weapType != "WEAP") throw new InvalidOperationException($"Expected WEAP at {pos}, got {weapType}");

var weapBytes = full[pos..];
File.WriteAllBytes(outPath, weapBytes);
Console.WriteLine($"Wrote {weapBytes.Length} bytes (WEAP record only) to {outPath}");

workDir.Delete(recursive: true);
