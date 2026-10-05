using System.Globalization;
using System.Text;
using MEditService.Codec.Schema;
using MEditService.Codec.Serialization;
using MEditService.LoadOrder;
using MEditService.PluginAdapter;
using MEditService.SourceAdapter;
using Mutagen.Bethesda;
using Mutagen.Bethesda.Plugins;

namespace MEditService.Commands.Edits;

/// <summary>The one place a new FormKey is drawn (plugins.md, Create record, stories 2 and 3). One gesture
/// draws all its keys from one allocator, so none is drawn twice.</summary>
internal sealed class FormKeyAllocator
{
    private readonly PluginAddress _plugin;
    private readonly GameRelease _release;
    private readonly bool _isLight;
    private readonly bool _eslFlagIsRemovable;
    private readonly IReadOnlySet<string> _used;
    private readonly HashSet<string> _drawn = new(StringComparer.Ordinal);

    private FormKeyAllocator(
        PluginAddress plugin, GameRelease release, bool eslFlagIsRemovable, IReadOnlySet<string> used)
    {
        _plugin = plugin;
        _release = release;
        _eslFlagIsRemovable = eslFlagIsRemovable;
        _isLight = eslFlagIsRemovable || plugin.Name.EndsWith(".esl", StringComparison.OrdinalIgnoreCase);
        _used = used;
    }

    internal static FormKeyAllocator Over(SourceRepository repository, PluginAddress plugin, GameRelease release) =>
        new(plugin, release, IsLightByRemovableFlag(repository, plugin), repository.FormKeysUsed(plugin));

    /// <summary>The next free FormKey. Non-null is the refusal, and <paramref name="formKey"/> is "" then.</summary>
    internal RecordEditResult? Next(out string formKey)
    {
        if (NextFreeNativeFormId(_isLight) is { } allocated)
        {
            formKey = allocated;
            _drawn.Add(formKey);
            return null;
        }

        formKey = "";
        var freeAboveTheLightCap = _isLight && _eslFlagIsRemovable && NextFreeNativeFormId(isLight: false) != null;
        return RecordEditResult.Refused(
            RecordEditRefusal.FormKeySpaceExhausted, ExhaustedMessage(freeAboveTheLightCap));
    }

    /// <summary>A FormKey the user asked for, which must be native, in range and free. Non-null is the
    /// refusal, and <paramref name="formKey"/> is "" then.</summary>
    internal RecordEditResult? Claim(string requestedFormKey, out string formKey)
    {
        formKey = "";
        if (RefuseIfNotNativeTarget(requestedFormKey) is { } notNative) return notNative;
        if (_used.Contains(requestedFormKey))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{requestedFormKey} is already held by a record in {_plugin.Name} at some ref.");
        }

        formKey = requestedFormKey;
        return null;
    }

    // The working tree's header document decides (ADR-0007), so a flag flipped this
    // session caps minting immediately.
    private static bool IsLightByRemovableFlag(SourceRepository repository, PluginAddress plugin)
    {
        var headerFormKey = PluginHeader.FormKeyFor(ModKey.FromFileName(plugin.Name));
        var header = repository.Get(plugin, new RecordIdentity(headerFormKey, PluginHeader.RecordType, null));
        return header?.Body is { } body && HeaderDocument.IsLight(Encoding.UTF8.GetBytes(body));
    }

    private bool IsNative(string formKey) =>
        FormKey.TryFactory(formKey, out var parsed)
        && parsed.ModKey.FileName.String.Equals(_plugin.Name, StringComparison.OrdinalIgnoreCase);

    // A foreign ModKey would land a record inside this plugin's tree while claiming another origin,
    // indistinguishable from a corrupt override; xEdit never offers one either. Range is checked
    // after ownership.
    private RecordEditResult? RefuseIfNotNativeTarget(string requestedFormKey)
    {
        var parsed = FormKey.Factory(requestedFormKey);
        if (!IsNative(requestedFormKey))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.NotNativeRecord,
                $"{requestedFormKey} belongs to {parsed.ModKey.FileName.String}, not {_plugin.Name} — a requested FormKey " +
                "must be native to the plugin that is to hold it.");
        }

        if (_isLight && parsed.ID > PluginFlagPredicates.LightLocalFormIdCap)
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.LightPluginFormIdOutOfRange,
                $"{requestedFormKey} exceeds {_plugin.Name}'s ESL local FormID range — a light-flagged " +
                $"plugin can only address local FormIDs up to 0x{PluginFlagPredicates.LightLocalFormIdCap:X}. " +
                "Choose a FormID within that range, or un-flag the plugin as ESL.");
        }

        return null;
    }

    // Null means exhausted.
    private string? NextFreeNativeFormId(bool isLight)
    {
        var floor = PluginFlagPredicates.HighRangeFormIdFloor(_release);
        var highest = _used
            .Where(IsNative)
            .Concat(_drawn)
            .Select(LocalId)
            .DefaultIfEmpty(0u)
            .Max();
        var next = Math.Max(floor, highest + 1);
        var cap = isLight ? PluginFlagPredicates.LightLocalFormIdCap : FormID.FullIdMask;
        return next > cap ? null : $"{next:X6}:{_plugin.Name}";
    }

    // Every branch names both remedies, even where one is moot for this plugin.
    private string ExhaustedMessage(bool freeAboveTheLightCap)
    {
        const string remedies = "Clear the light flag in the header, or change a record's FormID.";
        if (freeAboveTheLightCap)
        {
            return $"{_plugin.Name} has exhausted its ESL FormKey space — every local FormID up to 0xFFF is " +
                "already in use (a light-flagged plugin's addressable range) — but native space remains " +
                $"free above it. {remedies}";
        }
        return _isLight
            ? $"{_plugin.Name} has exhausted its ESL FormKey space — every local FormID up to 0xFFF is " +
              $"already in use (a light-flagged plugin's addressable range). {remedies}"
            : $"{_plugin.Name} has exhausted its FormKey space — every local FormID up to 0xFFFFFF is " +
              $"already in use. {remedies}";
    }

    private static uint LocalId(string formKey) =>
        uint.Parse(formKey[..formKey.IndexOf(':')], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
}
