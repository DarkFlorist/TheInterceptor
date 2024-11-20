export function ArrowIcon(param: { color: string }) {
	return <>
		<svg style = 'vertical-align: middle;' width = '24' height = '24' viewBox = '0 0 24 24'>
			<path fill = { param.color } d = 'M13 7v-6l11 11-11 11v-6h-13v-10z'/>
		</svg>
	</>
}

export function ApproveIcon(param: { color: string }) {
	return <>
		<svg x = '0px' y = '0px' viewBox = '0 0 122.88 98.75' style = 'enable-background: new 0 0 122.88 98.75' width = '24' height = '24'>
			<g>
				<path
					fill = { param.color }
					class = 'st0'
					d = 'M76.71,23.6l15.76,15.97v7.51l-7.46,0v-5.65h-6.18v-6.18h-5.91l-1.71-5.57c-2.72,1.82-6.03,2.88-9.58,2.88 c-9.32,0-16.88-7.29-16.88-16.28C44.75,7.29,52.31,0,61.63,0c9.32,0,16.88,7.29,16.88,16.28C78.51,18.91,77.86,21.4,76.71,23.6 L76.71,23.6L76.71,23.6z M0,45.47h24.83v44.18H0V45.47L0,45.47z M29.83,85.94V49.02h16.61c7.04,1.26,14.08,5.08,21.12,9.51h12.9 c5.84,0.35,8.9,6.27,3.22,10.16c-4.53,3.32-10.49,3.13-16.61,2.58c-4.22-0.21-4.4,5.46,0,5.48c1.53,0.12,3.19-0.24,4.64-0.24 c7.63-0.01,13.92-1.47,17.77-7.5l1.93-4.51l19.19-9.51c9.6-3.16,16.42,6.88,9.35,13.87C106.06,78.96,91.81,87.28,77.23,94 c-10.59,6.44-21.18,6.22-31.76,0L29.83,85.94L29.83,85.94z M59.2,11.07c1.66,0,3.01,1.35,3.01,3.01c0,1.66-1.35,3.01-3.01,3.01 c-1.67,0-3.01-1.35-3.01-3.01C56.19,12.41,57.54,11.07,59.2,11.07L59.2,11.07z'
				/>
			</g>
		</svg>
	</>
}

export const BroomIcon = () => {
	return <svg role = 'img' width = '1em' height = '1em' viewBox = '0 0 100 100' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'>
		<path d = 'M50.8339 47.7216C44.9583 43.6222 36.25 40.4333 30.75 49.5444M50.8339 47.7216C58.7083 54.1 56.4166 60.4778 54.5833 65.9444M50.8339 47.7216L83.9167 9M30.75 49.5444C22.0416 63.6667 14.25 70.5 6 76.4222C12.4167 84.1667 21.125 86.9 21.125 86.9M30.75 49.5444L54.5833 65.9444M54.5833 65.9444C52.7499 74.1444 56.4166 85.5333 57.3333 91H38.9999M21.125 86.9C21.125 86.9 27.0833 76.8778 29.8333 72.3222M21.125 86.9C29.375 90.5444 38.9999 91 38.9999 91M38.9999 91C38.9999 91 41.2916 85.5333 41.7499 83.7111M74.2404 73.6888H87.125M75.6154 60.0221H81.6249M74.6988 87.3554H94' stroke = 'currentColor' stroke-width = '7' stroke-linecap = 'round' />
	</svg>
}

export const XMarkIcon = () => {
	return <svg width = '1em' height = '1em' viewBox = '0 0 16 16' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'>
		<path d = 'M3 3L13 13M13 3L3 13' stroke = 'currentColor' stroke-width = '2' stroke-linecap = 'round'/>
	</svg>
}

export const RequestBlockedIcon = () =>
	<svg width = '1em' height = '1em' viewBox = '0 0 16 16' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'>
		<path d = 'M9.33755 12.7205C9.33755 12.9279 9.27472 13.1307 9.15701 13.3031C9.0393 13.4756 8.872 13.61 8.67625 13.6894C8.4805 13.7688 8.26511 13.7895 8.05731 13.7491C7.8495 13.7086 7.65863 13.6087 7.50881 13.4621C7.35899 13.3154 7.25696 13.1285 7.21563 12.9251C7.17429 12.7216 7.19551 12.5108 7.27659 12.3191C7.35767 12.1275 7.49498 11.9637 7.67114 11.8484C7.84731 11.7332 8.05442 11.6717 8.2663 11.6717C8.55041 11.6717 8.82289 11.7822 9.02379 11.9789C9.22469 12.1756 9.33755 12.4423 9.33755 12.7205ZM14.2252 4.59251L15.2643 3.57586C15.4152 3.4281 15.5 3.22768 15.5 3.01871C15.5 2.80973 15.4152 2.60932 15.2643 2.46155C15.1133 2.31378 14.9086 2.23077 14.6952 2.23077C14.4817 2.23077 14.277 2.31378 14.1261 2.46155L13.0869 3.4782L12.0485 2.46286C11.8976 2.31509 11.6928 2.23208 11.4794 2.23208C11.2659 2.23208 11.0612 2.31509 10.9103 2.46286C10.7594 2.61063 10.6746 2.81104 10.6746 3.02002C10.6746 3.22899 10.7594 3.42941 10.9103 3.57718L11.9487 4.59251L10.9116 5.60916C10.7607 5.75693 10.6759 5.95735 10.6759 6.16632C10.6759 6.37529 10.7607 6.57571 10.9116 6.72348C11.0626 6.87124 11.2673 6.95426 11.4807 6.95426C11.6942 6.95426 11.8989 6.87124 12.0498 6.72348L13.0869 5.70683L14.1254 6.72413C14.2001 6.7973 14.2889 6.85534 14.3865 6.89494C14.4841 6.93453 14.5888 6.95492 14.6945 6.95492C14.8002 6.95492 14.9048 6.93453 15.0025 6.89494C15.1001 6.85534 15.1889 6.7973 15.2636 6.72413C15.3383 6.65097 15.3976 6.5641 15.4381 6.46851C15.4785 6.37291 15.4993 6.27045 15.4993 6.16697C15.4993 6.0635 15.4785 5.96104 15.4381 5.86544C15.3976 5.76985 15.3383 5.68298 15.2636 5.60982L14.2252 4.59251ZM11.4198 9.52828C10.5042 8.8761 9.40097 8.52478 8.26864 8.52478C7.13632 8.52478 6.03312 8.8761 5.11748 9.52828C4.94524 9.6511 4.82988 9.83587 4.7968 10.042C4.76371 10.248 4.8156 10.4586 4.94106 10.6272C5.06651 10.7958 5.25525 10.9087 5.46576 10.9411C5.67626 10.9735 5.89129 10.9227 6.06353 10.7999C6.70435 10.3437 7.47631 10.098 8.26864 10.098C9.06097 10.098 9.83294 10.3437 10.4738 10.7999C10.646 10.9227 10.861 10.9735 11.0715 10.9411C11.282 10.9087 11.4708 10.7958 11.5962 10.6272C11.7217 10.4586 11.7736 10.248 11.7405 10.042C11.7074 9.83587 11.592 9.6511 11.4198 9.52828ZM9.06974 3.01936C9.06974 2.81075 8.98509 2.61068 8.83442 2.46317C8.68374 2.31566 8.47938 2.23279 8.2663 2.23279C5.54164 2.23416 2.90139 3.15845 0.793629 4.84881C0.712079 4.91435 0.644516 4.99499 0.594796 5.0861C0.545076 5.17721 0.514173 5.27702 0.503853 5.37982C0.493532 5.48263 0.503996 5.58641 0.534646 5.68526C0.565296 5.78411 0.615532 5.87607 0.682487 5.95591C0.749441 6.03575 0.831803 6.10189 0.924868 6.15057C1.01793 6.19925 1.11988 6.2295 1.22489 6.2396C1.3299 6.24971 1.43591 6.23946 1.53688 6.20946C1.63784 6.17945 1.73178 6.13027 1.81333 6.06472C3.63357 4.60523 5.91349 3.80718 8.2663 3.80594C8.47938 3.80594 8.68374 3.72307 8.83442 3.57555C8.98509 3.42804 9.06974 3.22797 9.06974 3.01936ZM9.06974 6.16566C9.06974 5.95705 8.98509 5.75698 8.83442 5.60947C8.68374 5.46196 8.47938 5.37909 8.2663 5.37909C6.3341 5.37208 4.4574 6.01127 2.94685 7.19083C2.78401 7.32169 2.68019 7.50992 2.65773 7.71499C2.63528 7.92006 2.696 8.12556 2.82681 8.28723C2.95761 8.4489 3.14805 8.5538 3.3571 8.57935C3.56614 8.60489 3.77707 8.54903 3.94446 8.42379C5.17176 7.46556 6.69651 6.94639 8.2663 6.95224C8.47938 6.95224 8.68374 6.86937 8.83442 6.72186C8.98509 6.57435 9.06974 6.37428 9.06974 6.16566Z' fill = 'currentColor' />
	</svg>

export const InterceptorDisabledIcon = () => <svg width = '1em' height = '1em' viewBox = '0 0 16 16' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'>
	<path fill-rule = 'evenodd' clip-rule = 'evenodd' d = 'M6.76818 14.4604C6.46964 14.5771 6.18037 14.6403 5.99955 14.6403C4.57564 14.6403 3.80216 14.2596 2.8187 13.103C2.31172 12.5633 3.22755 10.6254 3.47286 10.1266C3.50557 10.0448 3.50557 9.96302 3.46468 9.88942L2.40167 8.04142C2.35261 7.95148 2.36079 7.84518 2.4262 7.76341C2.45891 7.72252 2.4998 7.69799 2.54068 7.68164L4.63399 6.95388C4.70758 6.92935 4.79753 6.93753 4.86294 6.98659L6.08949 7.88606C6.20397 7.97601 6.22032 8.14772 6.1222 8.25403C5.38627 9.05537 4.14337 10.6826 4.85477 11.9337L5.84418 12.9967C6.69425 12.3489 7.54149 11.6976 8.34634 10.9933C8.48333 10.8563 8.63391 10.731 8.78413 10.6059C8.87372 10.5313 8.96319 10.4568 9.04956 10.38C9.2622 10.1674 9.35551 9.92906 9.38482 9.63594C9.40935 9.31703 9.26216 9.00631 9.0005 8.81824L5.32903 6.12801C5.07555 5.93994 4.74847 5.89088 4.4541 5.99718L2.17272 6.79852C1.77623 6.93729 1.40532 7.4229 1.38773 7.84518C1.36675 8.22269 0.78619 8.3475 0.668151 7.95965C0.357425 7.01112 -0.427566 4.3536 0.300186 3.56861C1.1833 2.6119 3.32567 1.14822 4.69123 1.38536C6.05679 1.63067 16 5.71098 16 5.71098L13.3098 7.89424L12.6638 12.6941L10.9712 11.4512C9.28669 13.2175 7.06673 14.3436 6.76818 14.4604ZM8.85603 5.81434C8.85423 5.83688 8.85331 5.85968 8.85331 5.8827C8.85331 5.92481 8.85639 5.96619 8.86232 6.00662L8.17813 6.67731C8.06472 6.78834 8.00101 6.93893 8.00101 7.09595C8.00101 7.25296 8.06472 7.40355 8.17813 7.51458C8.29154 7.62561 8.44535 7.68798 8.60573 7.68798C8.76612 7.68798 8.91994 7.62561 9.03334 7.51458L9.8126 6.7507L10.5929 7.51507C10.649 7.57005 10.7157 7.61366 10.789 7.64341C10.8624 7.67316 10.9411 7.68847 11.0205 7.68847C11.0999 7.68847 11.1785 7.67316 11.2519 7.64341C11.3253 7.61366 11.3919 7.57005 11.4481 7.51507C11.5042 7.46009 11.5488 7.39483 11.5792 7.323C11.6096 7.25117 11.6252 7.17419 11.6252 7.09644C11.6252 7.01869 11.6096 6.94171 11.5792 6.86988C11.5488 6.79805 11.5042 6.73278 11.4481 6.67781L10.6678 5.91343L11.4486 5.14955C11.562 5.03852 11.6257 4.88794 11.6257 4.73092C11.6257 4.5739 11.562 4.42332 11.4486 4.31229C11.3352 4.20126 11.1814 4.13889 11.021 4.13889C10.8606 4.13889 10.7068 4.20126 10.5934 4.31229L9.83706 5.05224C9.81837 5.04909 9.79947 5.04656 9.78037 5.04466L9.03234 4.31327C8.91893 4.20225 8.76511 4.13987 8.60473 4.13987C8.44435 4.13987 8.29053 4.20225 8.17712 4.31327C8.06371 4.4243 8 4.57489 8 4.73191C8 4.88892 8.06371 5.03951 8.17712 5.15054L8.85603 5.81434Z' fill = 'currentColor' />
</svg>

export const TrashIcon = () => <svg width = '1em' height = '1em' viewBox = '0 0 16 16' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'>
	<path fill-rule = 'evenodd' clip-rule = 'evenodd' d = 'M6.01632 1.62773C5.83827 1.80578 5.76002 2.00587 5.76002 2.14857V2.92571H10.24V2.14857C10.24 2.00587 10.1618 1.80578 9.98372 1.62773C9.80567 1.44968 9.60557 1.37143 9.46288 1.37143H6.53716C6.39446 1.37143 6.19437 1.44968 6.01632 1.62773ZM11.6114 2.92571V2.14857C11.6114 1.55984 11.324 1.02851 10.9535 0.657984C10.5829 0.287461 10.0516 0 9.46288 0H6.53716C5.94843 0 5.4171 0.287461 5.04657 0.657984C4.67605 1.02851 4.38859 1.55984 4.38859 2.14857V2.92571H1.41716C1.03845 2.92571 0.731445 3.23272 0.731445 3.61143C0.731445 3.99014 1.03845 4.29714 1.41716 4.29714H2.1943V13.8514C2.1943 14.4402 2.48176 14.9715 2.85229 15.342C3.22281 15.7125 3.75414 16 4.34287 16H11.6572C12.2459 16 12.7772 15.7125 13.1477 15.342C13.5183 14.9715 13.8057 14.4402 13.8057 13.8514V4.29714H14.5829C14.9616 4.29714 15.2686 3.99014 15.2686 3.61143C15.2686 3.23272 14.9616 2.92571 14.5829 2.92571H11.6114ZM3.56573 4.29714V13.8514C3.56573 13.9941 3.64398 14.1942 3.82203 14.3723C4.00008 14.5503 4.20018 14.6286 4.34287 14.6286H11.6572C11.7999 14.6286 12 14.5503 12.178 14.3723C12.3561 14.1942 12.4343 13.9941 12.4343 13.8514V4.29714H3.56573ZM6.53716 6.58286C6.91587 6.58286 7.22287 6.88986 7.22287 7.26857V11.6571C7.22287 12.0359 6.91587 12.3429 6.53716 12.3429C6.15845 12.3429 5.85145 12.0359 5.85145 11.6571V7.26857C5.85145 6.88986 6.15845 6.58286 6.53716 6.58286ZM9.46288 6.58286C9.84158 6.58286 10.1486 6.88986 10.1486 7.26857V11.6571C10.1486 12.0359 9.84158 12.3429 9.46288 12.3429C9.08417 12.3429 8.77716 12.0359 8.77716 11.6571V7.26857C8.77716 6.88986 9.08417 6.58286 9.46288 6.58286Z' fill = 'currentColor'/>
</svg>

export const SearchIcon = () => <svg width = '1em' height = '1em' viewBox = '0 0 16 16' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'>
	<path d = 'M15 15L11.4563 11.4563M11.4563 11.4563C12.0251 10.8876 12.4763 10.2123 12.7841 9.46918C13.0919 8.72604 13.2504 7.92955 13.2504 7.12518C13.2504 6.32081 13.0919 5.52431 12.7841 4.78117C12.4763 4.03803 12.0251 3.3628 11.4563 2.79402C10.8876 2.22525 10.2123 1.77407 9.46918 1.46625C8.72604 1.15843 7.92955 1 7.12518 1C6.32081 1 5.52431 1.15843 4.78117 1.46625C4.03803 1.77407 3.3628 2.22525 2.79402 2.79402C1.64533 3.94272 1 5.50068 1 7.12518C1 8.74967 1.64533 10.3076 2.79402 11.4563C3.94272 12.605 5.50068 13.2504 7.12518 13.2504C8.74967 13.2504 10.3076 12.605 11.4563 11.4563Z' stroke = 'currentColor' stroke-width = '2' stroke-linecap = 'round' stroke-linejoin = 'round' />
</svg>

export const CopyIcon = () => <svg width = '1em' height = '1em' viewBox = '0 0 24 24' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'><path d = 'M14.188 4.813H4.813v9.375h.937V17H3.875A1.875 1.875 0 0 1 2 15.125V3.875C2 2.839 2.84 2 3.875 2h11.25C16.16 2 17 2.84 17 3.875V5.75h-2.812z' fill = 'currentColor' /><path fill-rule = 'evenodd' clip-rule = 'evenodd' d = 'M7 20V9a2 2 0 0 1 2-2h11a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2m12-1h-9v-9h9z' fill = 'currentColor' /></svg>

export const EditIcon = () => <svg width = '1em' height = '1em' viewBox = '0 0 24 24' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'><path fill-rule = 'evenodd' clip-rule = 'evenodd' d = 'M10 3H7v2H4a3 3 0 0 0-3 3v8a3 3 0 0 0 3 3h3v2h3zM7 8v8H5a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1z' fill = 'currentColor' /><path d = 'M19 16h-7v3h8a3 3 0 0 0 3-3V8a3 3 0 0 0-3-3h-8v3h7a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1' fill = 'currentColor' /></svg>

export const CheckIcon = () => <svg width = '1em' height = '1em' viewBox = '0 0 24 24' fill = 'none' xmlns = 'http://www.w3.org/2000/svg'><path fill-rule = 'evenodd' clip-rule = 'evenodd' d = 'M22.08 6.04 8.478 20.163l-6.558-6.81 2.16-2.081 4.398 4.566L19.92 3.959z' fill = 'currentColor'/></svg>
