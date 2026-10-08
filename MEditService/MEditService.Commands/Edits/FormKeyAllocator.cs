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
/// draws all its keys from one allocator and writes <see cref="HeaderChanges"/> with them.</summary>
internal sealed class FormKeyAllocator
{
    private readonly SourceRepository _repository;
    private readonly PluginAddress _plugin;
    private readonly GameRelease _release;
    private readonly SourceDocument? _header;
    private readonly bool _isLight;
    private readonly bool _lightByFlagAlone;
    private readonly IReadOnlySet<string> _used;
    private readonly uint _nextObjectIdHeld;
    private uint _nextObjectId;

    private FormKeyAllocator(SourceRepository repository, PluginAddress plugin, GameRelease release, SourceDocument? header)
    {
        (_repository, _plugin, _release, _header) = (repository, plugin, release, header);
        var headerBody = header is null ? null : Encoding.UTF8.GetBytes(header.Body);
        _nextObjectIdHeld = _nextObjectId = headerBody is null ? 0 : HeaderDocument.NextObjectId(headerBody);
        // The working tree's header document decides (ADR-0007), so a flag flipped this session caps
        // minting immediately.
        var lightByExtension = plugin.Name.EndsWith(".esl", StringComparison.OrdinalIgnoreCase);
        _lightByFlagAlone = !lightByExtension && headerBody is not null && HeaderDocument.IsLight(headerBody);
        _isLight = lightByExtension || _lightByFlagAlone;
        _used = repository.FormKeysUsed(plugin);
    }

    internal static FormKeyAllocator Over(SourceRepository repository, PluginAddress plugin, GameRelease release) =>
        new(repository, plugin, release, repository.RecordOf(plugin, PluginHeader.IdentityOf(plugin.Name)));

    /// <summary>The first FormKey at or above the Next Object ID that no record uses. Non-null is the
    /// refusal, and <paramref name="formKey"/> is "" then.</summary>
    internal RecordEditResult? Next(out string formKey)
    {
        formKey = "";
        if (RefuseWithoutHeader() is { } headerless) return headerless;
        var free = FirstFreeId();
        if (free > Cap) return RecordEditResult.Refused(RecordEditRefusal.FormKeySpaceExhausted, ExhaustedMessage());

        formKey = KeyOf(free);
        _nextObjectId = free + 1;
        return null;
    }

    /// <summary>A FormKey the user asked for, which must be native, in range and free. Non-null is the
    /// refusal, and <paramref name="formKey"/> is "" then.</summary>
    internal RecordEditResult? Claim(string requestedFormKey, out string formKey)
    {
        formKey = "";
        if (RefuseWithoutHeader() is { } headerless) return headerless;
        if (RefuseIfNotNativeTarget(requestedFormKey) is { } notNative) return notNative;
        if (_used.Contains(requestedFormKey))
        {
            return RecordEditResult.Refused(
                RecordEditRefusal.FormKeyCollision,
                $"{requestedFormKey} is already held by a record in {_plugin.Name}.");
        }

        formKey = requestedFormKey;
        _nextObjectId = Math.Max(_nextObjectId, FormKey.Factory(requestedFormKey).ID + 1);
        return null;
    }

    /// <summary>The header document's rewrite that moves its Next Object ID past every FormKey drawn or
    /// claimed, written nowhere. None when nothing passed it.</summary>
    internal SourceChanges HeaderChanges() =>
        _header is { } header && _nextObjectId > _nextObjectIdHeld
            ? _repository.ChangesToRewrite(_plugin, header with
            {
                Body = Encoding.UTF8.GetString(HeaderDocument.WithNextObjectId(Encoding.UTF8.GetBytes(header.Body), _nextObjectId)),
            })
            : SourceChanges.None;

    private RecordEditResult? RefuseWithoutHeader() =>
        _header is null
            ? RecordEditResult.Refused(
                RecordEditRefusal.PluginSourceUnreadable,
                $"{_plugin.Name} ({_plugin.Origin}) has no header document, so its Next Object ID is unknown. " +
                "Check the Source Control panel.")
            : null;

    private uint FirstFreeId()
    {
        var id = Math.Max(_nextObjectId, PluginFlagPredicates.HighRangeFormIdFloor(_release));
        var taken = _used.Where(IsNative).Select(LocalId).Where(used => used >= id).ToHashSet();
        while (taken.Contains(id)) id++;
        return id;
    }

    private uint Cap => _isLight ? PluginFlagPredicates.LightLocalFormIdCap : FormID.FullIdMask;

    private string KeyOf(uint id) => $"{id:X6}:{_plugin.Name}";

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

    // Clearing the flag cannot make a .esl full, so only a plugin the flag alone makes light is told to.
    private string ExhaustedMessage()
    {
        var noneFree = $"{_plugin.Name} has no FormKey free at or above its Next Object ID";
        if (!_isLight) return $"{noneFree}, up to 0xFFFFFF.";
        var lightRange = $"{noneFree}, up to 0xFFF, the last a light plugin can address.";
        return _lightByFlagAlone ? $"{lightRange} Clear the light flag in the header to draw above it." : lightRange;
    }

    private static uint LocalId(string formKey) =>
        uint.Parse(formKey[..formKey.IndexOf(':')], NumberStyles.HexNumber, CultureInfo.InvariantCulture);
}
